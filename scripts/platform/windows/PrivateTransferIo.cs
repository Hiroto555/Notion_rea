using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text.Json;
using System.Runtime.Versioning;
using Microsoft.Win32.SafeHandles;
[SupportedOSPlatform("windows")]
// Private transfer I/O v1: single-dispatch append-at-EOF for resumable blob
// transfer partials. Wire is the shared binary frame
// [u32LE ASCII JSON-header length][header<=8192][payload<=1MiB]; the reply is
// header-only <=16KiB. state="APPLIED" only after every proof; any failure
// after the first write is state="UNKNOWN" (status 3) — never an implicit
// retry, truncate, delete, or overwrite.
internal static partial class PrivateRootProbeProgram {
 const int TransferIoMaxHeaderBytes=8192;
 const int TransferIoMaxPayloadBytes=1024*1024;
 const int TransferIoMaxStdinBytes=4+TransferIoMaxHeaderBytes+TransferIoMaxPayloadBytes;
 const int TransferIoMaxReplyBytes=16*1024;
 const long TransferIoMaxBytes=20_000_000;
 sealed class IoTransferRequest {
  public IoRequest Common;
  public long ByteLength;
  public long MaxBytes;
  public byte[] Payload;
 }
 sealed class IoTransferOutcome {
  public object Response;
  public int Status;
 }
 // Strict append contract parser: contractVersion 1, exact key set, bounded
 // frame. The payload is the exact bytes to append — no base64 indirection.
 static IoTransferRequest IoReadTransferRequest(){
  using var input=Console.OpenStandardInput();
  using var buffer=new MemoryStream();
  byte[] chunk=new byte[8192];
  for(;;){
   int remaining=TransferIoMaxStdinBytes+1-(int)buffer.Length;
   int count=input.Read(chunk,0,Math.Min(chunk.Length,remaining));
   if(count==0)break;
   buffer.Write(chunk,0,count);
   IoRequire(buffer.Length<=TransferIoMaxStdinBytes);
  }
  byte[] encoded=buffer.ToArray();
  IoRequire(encoded.Length>=4);
  int headerLength=encoded[0]|(encoded[1]<<8)|(encoded[2]<<16)|(encoded[3]<<24);
  IoRequire(headerLength>0&&headerLength<=TransferIoMaxHeaderBytes&&encoded.Length>=4+headerLength);
  byte[] headerBytes=new byte[headerLength];
  Array.Copy(encoded,4,headerBytes,0,headerLength);
  foreach(byte b in headerBytes)IoRequire(b<0x80);
  string json=System.Text.Encoding.ASCII.GetString(headerBytes);
  using var document=JsonDocument.Parse(json,new JsonDocumentOptions {AllowTrailingCommas=false,CommentHandling=JsonCommentHandling.Disallow,MaxDepth=4});
  JsonElement obj=document.RootElement;
  IoRequire(obj.ValueKind==JsonValueKind.Object);
  var fields=new Dictionary<string,JsonElement>(StringComparer.Ordinal);
  foreach(JsonProperty property in obj.EnumerateObject()){
   IoRequire(!fields.ContainsKey(property.Name));
   fields.Add(property.Name,property.Value);
  }
  var names=new HashSet<string>(new[]{"contractVersion","operation","path","root","rootFileId","rootVolumeId","directoryFileId","directoryVolumeId","attemptId","fileId","volumeId","expectedSha256","byteLength","maxBytes","payloadSha256"},StringComparer.Ordinal);
  IoRequire(fields.Count==names.Count);
  foreach(string name in fields.Keys)IoRequire(names.Contains(name));
  IoRequire(IoInteger(fields["contractVersion"])==1);
  var r=new IoRequest {
   Operation=IoString(fields["operation"]),Path=IoCanonical(IoString(fields["path"])),Root=IoCanonical(IoString(fields["root"])),
   RootFileId=IoHex(fields["rootFileId"],32),RootVolumeId=IoHex(fields["rootVolumeId"],16),
   DirectoryFileId=IoHex(fields["directoryFileId"],32),DirectoryVolumeId=IoHex(fields["directoryVolumeId"],16),
   AttemptId=IoHex(fields["attemptId"],32,true),
   FileId=IoHex(fields["fileId"],32),VolumeId=IoHex(fields["volumeId"],16),
   ExpectedSha256=IoHex(fields["expectedSha256"],64,true)
  };
  IoRequire(r.Operation=="append");
  RelativeDirectorySegments(r.Path,r.Root);
  r.Parent=IoCanonical(System.IO.Path.GetDirectoryName(r.Path));
  IoRequire(Same(r.DirectoryVolumeId,r.RootVolumeId));
  IoRequire(Same(r.VolumeId,r.RootVolumeId));
  if(Same(r.Parent,r.Root))IoRequire(Same(r.DirectoryFileId,r.RootFileId));
  var request=new IoTransferRequest {Common=r};
  request.ByteLength=fields["byteLength"].GetInt64();
  request.MaxBytes=fields["maxBytes"].GetInt64();
  string payloadSha256=IoHex(fields["payloadSha256"],64,true);
  int payloadLength=encoded.Length-4-headerLength;
  IoRequire(request.ByteLength>=0&&request.ByteLength<=TransferIoMaxBytes);
  IoRequire(request.MaxBytes>0&&request.MaxBytes<=TransferIoMaxBytes);
  IoRequire(payloadLength>0&&payloadLength<=TransferIoMaxPayloadBytes);
  IoRequire(request.ByteLength+payloadLength<=request.MaxBytes);
  request.Payload=new byte[payloadLength];
  Array.Copy(encoded,4+headerLength,request.Payload,0,payloadLength);
  IoRequire(IoSha256(request.Payload)==payloadSha256);
  return request;
 }
 static IoTransferOutcome IoTransferFailure(IoTransferRequest request,string state){
  IoRequest r=request.Common;
  string reason=state=="EXISTS"?"PRIVATE_TRANSFER_EXISTS":state=="UNKNOWN"?"PRIVATE_TRANSFER_UNKNOWN":"PRIVATE_TRANSFER_REJECTED";
  int status=state=="EXISTS"?2:state=="UNKNOWN"?3:1;
  return new IoTransferOutcome {Status=status,Response=new {contractVersion=1,operation=r.Operation,path=r.Path,root=r.Root,attemptId=r.AttemptId,state,reason}};
 }
 // Derive the intended complete digest BEFORE the sole mutation, independently
 // of the post-write readback. Both hashes consume the exact same held prefix.
 static string IoTransferExpectedHash(FileStream stream,long prefixBytes,byte[] payload,string expectedPrefixHash){
  IoRequire(prefixBytes>=0&&prefixBytes<=TransferIoMaxBytes&&payload.Length>0&&
   payload.Length<=TransferIoMaxPayloadBytes&&prefixBytes+payload.Length<=TransferIoMaxBytes);
  stream.Position=0;
  using var prefix=IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
  using var intended=IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
  byte[] buffer=new byte[64*1024];
  long remaining=prefixBytes;
  while(remaining>0){
   int count=stream.Read(buffer,0,(int)Math.Min(buffer.Length,remaining));
   IoRequire(count>0);
   prefix.AppendData(buffer,0,count);intended.AppendData(buffer,0,count);
   remaining-=count;
  }
  IoRequire(stream.ReadByte()==-1&&stream.Length==prefixBytes);
  IoRequire(CryptographicOperations.FixedTimeEquals(prefix.GetHashAndReset(),Convert.FromHexString(expectedPrefixHash)));
  intended.AppendData(payload);
  return Convert.ToHexString(intended.GetHashAndReset()).ToLowerInvariant();
 }
 static string IoTransferVerifiedHash(FileStream stream,long total,string intendedHash){
  string observed=IoStreamHash(stream,total,(int)TransferIoMaxBytes);
  IoRequire(CryptographicOperations.FixedTimeEquals(Convert.FromHexString(observed),Convert.FromHexString(intendedHash)));
  return observed;
 }
 // Append-at-exact-EOF: the SAME read/write handle holds the file with no
 // write/delete sharing while ancestors stay pinned. Expected native
 // ID/size/hash + DACL/local NTFS/no reparse/nlink1 are proven BEFORE any
 // byte is appended; the append lands only at the proven EOF, never a
 // truncate; FlushFileBuffers + full same-handle readback/hash precede the
 // final proof. `attempted` marks the first write so every later failure is
 // UNKNOWN.
 static IoTransferOutcome IoTransferAppend(IoTransferRequest request,string sid,IoDirectoryLocks directories,ref bool attempted){
  IoRequest r=request.Common;
  IntPtr raw=CreateFileW(r.Path,IoGenericRead|IoGenericWrite|IoReadControl,IoShareRead,IntPtr.Zero,OpenExisting,FileFlagOpenReparsePoint|IoWriteThrough,IntPtr.Zero);
  IoRequire(raw!=new IntPtr(-1));
  using(var handle=new SafeFileHandle(raw,true)){
   IoAclProof(handle,sid,true);
   IoNtfsProof(handle);
   var proof=IoFileProof(handle,r.Path,r,sid,request.ByteLength,r.FileId);
   IoRequire(Same(proof.volumeId,r.VolumeId));
   using(var stream=new FileStream(handle,FileAccess.ReadWrite,4096,false)){
    // Full existing-file hash BEFORE append: identity+bytes+prefix content.
    string intendedHash=IoTransferExpectedHash(stream,request.ByteLength,request.Payload,r.ExpectedSha256);
    directories.Recheck();
    stream.Position=stream.Length;
    IoRequire(stream.Length==request.ByteLength);
    attempted=true; // The append below is the only mutation; no retry after it.
    stream.Write(request.Payload,0,request.Payload.Length);
    stream.Flush(true); // FlushFileBuffers on THIS file's handle.
    long total=request.ByteLength+request.Payload.Length;
    string fullHash=IoTransferVerifiedHash(stream,total,intendedHash);
    var file=IoFileProof(handle,r.Path,r,sid,total,proof.fileId);
    IoAclProof(handle,sid,true);
    IoNtfsProof(handle);
    var directory=directories.Recheck();
    return new IoTransferOutcome {Status=0,Response=new {
     contractVersion=1,operation=r.Operation,path=r.Path,root=r.Root,attemptId=r.AttemptId,state="APPLIED",
     file=IoEvidence(file,sid),directory=IoEvidence(directory,sid),
     byteLength=total,sha256=fullHash,contentFlushed=true,filesystem="NTFS",
     durability=IoV4Durability()
    }};
   }
  }
 }
 static int IoTransferOutput(IoTransferOutcome outcome,ref bool outputAttempted){
  IoRequire(IoPipes());
  byte[] header=JsonSerializer.SerializeToUtf8Bytes(outcome.Response,new JsonSerializerOptions {
   Encoder=System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping
  });
  IoRequire(header.Length>0&&header.Length<=TransferIoMaxReplyBytes);
  foreach(byte b in header)IoRequire(b<0x80);
  IoRequire(4+header.Length<=TransferIoMaxReplyBytes);
  outputAttempted=true;
  using var output=Console.OpenStandardOutput();
  byte[] length=new byte[4];
  length[0]=(byte)(header.Length&0xff);
  length[1]=(byte)((header.Length>>8)&0xff);
  length[2]=(byte)((header.Length>>16)&0xff);
  length[3]=(byte)((header.Length>>24)&0xff);
  output.Write(length,0,4);
  output.Write(header,0,header.Length);
  output.Flush();
  return outcome.Status;
 }
 // Public entry point for `--private-transfer-io`; parent owns the Main
 // dispatch and the .csproj Compile include.
 public static int RunPrivateTransferIo(){
  if(!IoPipes()){Console.Error.Write("WINDOWS_PRIVATE_TRANSFER_UNSAFE");return 1;}
  IoTransferRequest request=null;
  bool attempted=false;
  bool outputAttempted=false;
  IoTransferOutcome outcome=null;
  try{
   request=IoReadTransferRequest();
   using(var identity=WindowsIdentity.GetCurrent()){
    string sid=identity.User.Value;
    using(var directories=new IoDirectoryLocks(request.Common,sid)){
     directories.RecheckExclusive();
     outcome=IoTransferAppend(request,sid,directories,ref attempted);
     directories.RecheckExclusive();
    }
   }
  }catch{
   if(request!=null){
    try{outcome=IoTransferFailure(request,attempted?"UNKNOWN":"REJECTED");}catch{outcome=null;}
   }else outcome=null;
  }
  if(outcome==null){Console.Error.Write("WINDOWS_PRIVATE_TRANSFER_UNSAFE");return attempted||outputAttempted?3:1;}
  try{return IoTransferOutput(outcome,ref outputAttempted);}
  catch{Console.Error.Write("WINDOWS_PRIVATE_TRANSFER_UNSAFE");return 3;}
 }
}
