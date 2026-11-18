using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;
using System.Runtime.Versioning;
using Microsoft.Win32.SafeHandles;
[SupportedOSPlatform("windows")]
// Private recovery I/O v3 is a raw-bytes publication contract for the large
// crash-recovery payload (32 MiB + 4 KiB envelope allowance). The wire is
// binary: [u32LE JSON-header length][ASCII JSON header][exact payload bytes].
// The header carries every identity/hash/length field; the payload carries the
// raw bytes, never base64. Responses use the same frame; the response payload
// is the exact same-handle readback. Everything else reuses the locked-
// ancestor, same-handle proof and captured-pipe primitives from the main
// program file (the parent declares it partial and adds the CLI dispatch).
internal static partial class PrivateRootProbeProgram {
 const int RecoveryIoMaxPayloadBytes=32*1024*1024+4096;
 const int RecoveryIoMaxHeaderBytes=8192;
 const int RecoveryIoMaxStdinBytes=4+RecoveryIoMaxHeaderBytes+RecoveryIoMaxPayloadBytes;
 const int RecoveryIoMaxOutputBytes=4+RecoveryIoMaxHeaderBytes+RecoveryIoMaxPayloadBytes;
 sealed class IoV3Request {
  public IoRequest Common;
  public long ByteLength;
  public byte[] Payload;
  public bool HasExpectedSha256;
  public bool HasSha256;
 }
 sealed class IoV3Outcome {
  public object Response;
  public byte[] Payload;
  public int Status;
 }
 // Binary request frame. Input is bounded at max+1, never ReadToEnd; the
 // header is strict ASCII JSON parsed only after the complete frame is known.
 static IoV3Request IoReadV3Request(){
  using var input=Console.OpenStandardInput();
  using var buffer=new MemoryStream();
  byte[] chunk=new byte[8192];
  for(;;){
   int remaining=RecoveryIoMaxStdinBytes+1-(int)buffer.Length;
   int count=input.Read(chunk,0,Math.Min(chunk.Length,remaining));
   if(count==0)break;
   buffer.Write(chunk,0,count);
   IoRequire(buffer.Length<=RecoveryIoMaxStdinBytes);
  }
  byte[] encoded=buffer.ToArray();
  IoRequire(encoded.Length>=4);
  int headerLength=encoded[0]|(encoded[1]<<8)|(encoded[2]<<16)|(encoded[3]<<24);
  IoRequire(headerLength>0&&headerLength<=RecoveryIoMaxHeaderBytes&&encoded.Length>=4+headerLength);
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
  IoRequire(fields.ContainsKey("operation"));
  string operation=IoString(fields["operation"]);
  IoRequire(operation=="prepare"||operation=="commit-prepared"||operation=="read-private"||operation=="read-missing");
  var names=new HashSet<string>(new[]{"contractVersion","operation","path","root","rootFileId","rootVolumeId","directoryFileId","directoryVolumeId"},StringComparer.Ordinal);
  if(operation=="prepare")names.UnionWith(new[]{"attemptId","stagingPath","byteLength","sha256"});
  else if(operation=="commit-prepared")names.UnionWith(new[]{"attemptId","stagingPath","fileId","volumeId","byteLength","expectedSha256"});
  else if(operation=="read-private")names.UnionWith(new[]{"fileId","volumeId","maxBytes","expectedSha256"});
  // read-missing: the base root/directory identities alone — no file pin.
  IoRequire(fields.Count==names.Count||(operation=="read-private"&&fields.Count==names.Count-1&&!fields.ContainsKey("expectedSha256")));
  foreach(string name in fields.Keys)IoRequire(names.Contains(name));
  IoRequire(IoInteger(fields["contractVersion"])==3);
  var r=new IoRequest {
   Operation=operation,Path=IoCanonical(IoString(fields["path"])),Root=IoCanonical(IoString(fields["root"])),
   RootFileId=IoHex(fields["rootFileId"],32),RootVolumeId=IoHex(fields["rootVolumeId"],16),
   DirectoryFileId=IoHex(fields["directoryFileId"],32),DirectoryVolumeId=IoHex(fields["directoryVolumeId"],16)
  };
  RelativeDirectorySegments(r.Path,r.Root); // Strict descendant; no root-as-file.
  r.Parent=IoCanonical(System.IO.Path.GetDirectoryName(r.Path));
  IoRequire(Same(r.DirectoryVolumeId,r.RootVolumeId));
  if(Same(r.Parent,r.Root))IoRequire(Same(r.DirectoryFileId,r.RootFileId));
  int payloadLength=encoded.Length-4-headerLength;
  var request=new IoV3Request {Common=r};
  if(operation=="prepare"){
   r.AttemptId=IoHex(fields["attemptId"],32,true);
   r.StagingPath=IoCanonical(IoString(fields["stagingPath"]));
   RelativeDirectorySegments(r.StagingPath,r.Root);
   IoRequire(Same(IoCanonical(System.IO.Path.GetDirectoryName(r.StagingPath)),r.Parent));
   IoRequire(!Same(r.Path,r.StagingPath));
   IoRequire(fields["byteLength"].ValueKind==JsonValueKind.Number);
   request.ByteLength=fields["byteLength"].GetInt64();
   IoRequire(request.ByteLength>=0&&request.ByteLength<=RecoveryIoMaxPayloadBytes&&request.ByteLength==payloadLength);
   r.ExpectedSha256=IoHex(fields["sha256"],64,true);
   request.Payload=new byte[payloadLength];
   Array.Copy(encoded,4+headerLength,request.Payload,0,payloadLength);
   // Hash and canonical identity are proven BEFORE any CREATE_NEW.
   IoRequire(IoSha256(request.Payload)==r.ExpectedSha256);
  }else{
   IoRequire(payloadLength==0);
   if(operation=="commit-prepared"){
    r.AttemptId=IoHex(fields["attemptId"],32,true);
    r.StagingPath=IoCanonical(IoString(fields["stagingPath"]));
    RelativeDirectorySegments(r.StagingPath,r.Root);
    IoRequire(Same(IoCanonical(System.IO.Path.GetDirectoryName(r.StagingPath)),r.Parent));
    IoRequire(!Same(r.Path,r.StagingPath));
    r.FileId=IoHex(fields["fileId"],32);
    r.VolumeId=IoHex(fields["volumeId"],16);
    r.ExpectedSha256=IoHex(fields["expectedSha256"],64,true);
    IoRequire(fields["byteLength"].ValueKind==JsonValueKind.Number);
    request.ByteLength=fields["byteLength"].GetInt64();
    IoRequire(request.ByteLength>=0&&request.ByteLength<=RecoveryIoMaxPayloadBytes&&Same(r.VolumeId,r.RootVolumeId));
   }else if(operation=="read-private"){
    r.FileId=IoHex(fields["fileId"],32);
    r.VolumeId=IoHex(fields["volumeId"],16);
    if(fields.ContainsKey("expectedSha256")){r.ExpectedSha256=IoHex(fields["expectedSha256"],64,true);request.HasExpectedSha256=true;}
    r.MaxBytes=IoInteger(fields["maxBytes"]);
    IoRequire(r.MaxBytes>=0&&r.MaxBytes<=RecoveryIoMaxPayloadBytes&&Same(r.VolumeId,r.RootVolumeId));
   }
   // read-missing: path + root/directory identities only, no file pin.
  }
  return request;
 }
 static IoV3Outcome IoV3FailureOutcome(IoV3Request request,string state){
  IoRequest r=request.Common;
  string reason=state=="EXISTS"?"PRIVATE_IO_V3_EXISTS":state=="UNKNOWN"?"PRIVATE_IO_V3_UNKNOWN":"PRIVATE_IO_V3_REJECTED";
  int status=state=="EXISTS"?2:state=="UNKNOWN"?3:1;
  if(r.Operation=="prepare"||r.Operation=="commit-prepared")
   return new IoV3Outcome {Status=status,Payload=new byte[0],Response=new {contractVersion=3,operation=r.Operation,path=r.Path,root=r.Root,attemptId=r.AttemptId,stagingPath=r.StagingPath,state,reason}};
  return new IoV3Outcome {Status=status,Payload=new byte[0],Response=new {contractVersion=3,operation=r.Operation,path=r.Path,root=r.Root,state,reason}};
 }
 // Writes the private stage under the locked ancestors, proves it and flushes;
 // it never renames. Publication is only the paired commit-prepared operation.
 static IoV3Outcome IoV3Prepare(IoV3Request request,string sid,IoDirectoryLocks directories,ref bool attempted){
  IoRequest r=request.Common;
  byte[] payload=request.Payload;
  IntPtr descriptor=IntPtr.Zero;
  int lastError=0;
  SafeFileHandle stage;
  try{
   string sddl="O:"+sid+"G:"+sid+"D:P(A;;FA;;;"+sid+")";
   IoRequire(IoConvertSecurityDescriptor(sddl,1,out descriptor,out _));
   var attributes=new IO_SECURITY_ATTRIBUTES {Length=(uint)Marshal.SizeOf<IO_SECURITY_ATTRIBUTES>(),SecurityDescriptor=descriptor,InheritHandle=false};
   attempted=true; // Even an unsuccessful CREATE_NEW call is conservatively UNKNOWN.
   stage=IoCreateFile(r.StagingPath,IoGenericRead|IoGenericWrite|IoDeleteAccess|IoReadControl,IoShareRead,ref attributes,IoCreateNew,FileFlagOpenReparsePoint|IoWriteThrough,IntPtr.Zero);
   lastError=Marshal.GetLastWin32Error();
  }finally{if(descriptor!=IntPtr.Zero)IoLocalFree(descriptor);}
  if(stage.IsInvalid)return IoV3FailureOutcome(request,lastError==80||lastError==183?"EXISTS":"UNKNOWN");
  using(stage){
   var stagingProof=IoFileProof(stage,r.StagingPath,r,sid,0,null);
   IoAclProof(stage,sid,true);
   IoNtfsProof(stage);
   using(var stream=new FileStream(stage,FileAccess.ReadWrite,4096,false)){
    stream.Write(payload,0,payload.Length);
    stream.Flush(true);
    byte[] readback=IoReadExact(stream,payload.Length,RecoveryIoMaxPayloadBytes);
    string sha256=IoSha256(readback);
    var file=IoFileProof(stage,r.StagingPath,r,sid,payload.Length,stagingProof.fileId);
    IoAclProof(stage,sid,true);
    IoNtfsProof(stage);
    var directory=directories.Recheck();
    return new IoV3Outcome {Status=0,Payload=readback,Response=new {
     contractVersion=3,operation=r.Operation,path=r.Path,root=r.Root,attemptId=r.AttemptId,stagingPath=r.StagingPath,state="PREPARED",
     file=IoEvidence(file,sid),directory=IoEvidence(directory,sid),byteLength=payload.Length,sha256,
     contentFlushed=true,filesystem="NTFS"
    }};
   }
  }
 }
 // Reopens the exact caller stage under the same locks, re-verifies it and
 // renames no-replace on the SAME handle. A collision keeps the stage.
 static IoV3Outcome IoV3Commit(IoV3Request request,string sid,IoDirectoryLocks directories,ref bool attempted){
  IoRequest r=request.Common;
  attempted=true; // The stage exists once this request parses; no retry.
  IntPtr raw=CreateFileW(r.StagingPath,IoGenericRead|IoGenericWrite|IoDeleteAccess|IoReadControl,IoShareRead,IntPtr.Zero,OpenExisting,FileFlagOpenReparsePoint|IoWriteThrough,IntPtr.Zero);
  IoRequire(raw!=new IntPtr(-1));
  using(var handle=new SafeFileHandle(raw,true)){
   IoAclProof(handle,sid,true);
   IoNtfsProof(handle);
   var stagingProof=IoFileProof(handle,r.StagingPath,r,sid,request.ByteLength,r.FileId);
   IoRequire(Same(stagingProof.volumeId,r.VolumeId));
   int length=checked((int)request.ByteLength);
   using(var stream=new FileStream(handle,FileAccess.ReadWrite,4096,false)){
    byte[] bytes=IoReadExact(stream,length,RecoveryIoMaxPayloadBytes);
    string sha256=IoSha256(bytes);
    IoRequire(System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(Convert.FromHexString(sha256),Convert.FromHexString(r.ExpectedSha256)));
    directories.Recheck();
    if(!IoRenameNoReplace(handle,r.Path,out int error)){
     directories.Recheck();
     return IoV3FailureOutcome(request,error==80||error==183?"EXISTS":"UNKNOWN");
    }
    stream.Flush(true);
    IoRequire(System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(bytes,IoReadExact(stream,length,RecoveryIoMaxPayloadBytes)));
    var file=IoFileProof(handle,r.Path,r,sid,length,stagingProof.fileId);
    IoAclProof(handle,sid,true);
    IoNtfsProof(handle);
    var directory=directories.Recheck();
    return new IoV3Outcome {Status=0,Payload=bytes,Response=new {
     contractVersion=3,operation=r.Operation,path=r.Path,root=r.Root,attemptId=r.AttemptId,stagingPath=r.StagingPath,state="PUBLISHED",
     file=IoEvidence(file,sid),directory=IoEvidence(directory,sid),byteLength=length,sha256,
     contentFlushed=true,filesystem="NTFS",
     stagingDisposition="RENAMED_TO_FINAL",@namespace="EXCLUSIVE_NO_REPLACE",
     durability=new {profile="WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1",scope="PROCESS_CRASH"}
    }};
   }
  }
 }
 static IoV3Outcome IoV3Read(IoV3Request request,string sid,IoDirectoryLocks directories){
  IoRequest r=request.Common;
  IntPtr raw=CreateFileW(r.Path,IoGenericRead|IoReadControl,IoShareRead,IntPtr.Zero,OpenExisting,FileFlagOpenReparsePoint,IntPtr.Zero);
  IoRequire(raw!=new IntPtr(-1));
  using(var handle=new SafeFileHandle(raw,true)){
   var standard=IoInspect(handle,false);
   IoRequire(standard.EndOfFile<=r.MaxBytes&&standard.EndOfFile<=RecoveryIoMaxPayloadBytes);
   int length=checked((int)standard.EndOfFile);
   IoAclProof(handle,sid,false);
   IoNtfsProof(handle);
   IoFileProof(handle,r.Path,r,sid,length,r.FileId); // All proofs BEFORE bytes.
   using(var stream=new FileStream(handle,FileAccess.Read,4096,false)){
    byte[] bytes=IoReadExact(stream,length,RecoveryIoMaxPayloadBytes);
    string sha256=IoSha256(bytes);
    if(request.HasExpectedSha256)
     IoRequire(System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(Convert.FromHexString(sha256),Convert.FromHexString(r.ExpectedSha256)));
    var file=IoFileProof(handle,r.Path,r,sid,length,r.FileId);
    IoAclProof(handle,sid,false);
    IoNtfsProof(handle);
    var directory=directories.Recheck();
    // Private bytes go ONLY to the guarded captured pipe, never diagnostics.
    return new IoV3Outcome {Status=0,Payload=bytes,Response=new {
     contractVersion=3,operation=r.Operation,path=r.Path,root=r.Root,state="READ",
     file=IoEvidence(file,sid),directory=IoEvidence(directory,sid),byteLength=length,sha256,filesystem="NTFS"
    }};
   }
  }
 }
 // Absence probe under the SAME held ancestor locks: a nofollow open of the
 // path with read-only sharing and NO delete share. ERROR_FILE_NOT_FOUND (2)
 // is exact absence only with both parent proofs held; ERROR_PATH_NOT_FOUND
 // (3) contradicts the held parent and is UNKNOWN, never absence. An
 // existing handle is fully proven and reported as EXISTS — never deleted,
 // renamed or imported. Nothing mutates; the verdict is emitted only after
 // every owned handle scope has disposed.
 static IoV3Outcome IoV3Missing(IoV3Request request,string sid,IoDirectoryLocks directories){
  IoRequest r=request.Common;
  directories.RecheckExclusive();
  IntPtr raw=CreateFileW(r.Path,FileReadAttributes|IoReadControl,FileShareReadWrite,IntPtr.Zero,OpenExisting,FileFlagOpenReparsePoint,IntPtr.Zero);
  if(raw==new IntPtr(-1)){
   int error=Marshal.GetLastWin32Error();
   var directory=directories.RecheckExclusive();
   if(error==2)
    return new IoV3Outcome {Status=0,Payload=new byte[0],Response=new {
     contractVersion=3,operation=r.Operation,path=r.Path,root=r.Root,state="ABSENT",
     directory=IoEvidence(directory,sid)
    }};
   return IoV3FailureOutcome(request,"UNKNOWN");
  }
  using(var handle=new SafeFileHandle(raw,true)){
   IoInspect(handle,false);
   IoProof(handle,r.Path,r,sid);
   IoAclProof(handle,sid,false);
   IoNtfsProof(handle);
   directories.RecheckExclusive();
   // Bare failure-shape verdict (the strict parser accepts no evidence
   // fields); the file was still fully proven before this is emitted.
   return IoV3FailureOutcome(request,"EXISTS");
  }
 }
 // Captured-pipe binary output. The response object is serialized as the ASCII
 // JSON header; the payload follows unencoded. Assembled outcomes are emitted
 // only after every owned handle scope has disposed.
 static int IoV3Output(IoV3Outcome outcome,ref bool outputAttempted){
  IoRequire(IoPipes());
  byte[] header=JsonSerializer.SerializeToUtf8Bytes(outcome.Response,new JsonSerializerOptions {
   Encoder=System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping
  });
  IoRequire(header.Length>0&&header.Length<=RecoveryIoMaxHeaderBytes);
  foreach(byte b in header)IoRequire(b<0x80);
  byte[] payload=outcome.Payload??new byte[0];
  IoRequire(4+header.Length+payload.Length<=RecoveryIoMaxOutputBytes);
  outputAttempted=true;
  using var output=Console.OpenStandardOutput();
  byte[] length=new byte[4];
  length[0]=(byte)(header.Length&0xff);
  length[1]=(byte)((header.Length>>8)&0xff);
  length[2]=(byte)((header.Length>>16)&0xff);
  length[3]=(byte)((header.Length>>24)&0xff);
  output.Write(length,0,4);
  output.Write(header,0,header.Length);
  output.Write(payload,0,payload.Length);
  output.Flush();
  return outcome.Status;
 }
 static int PrivateRecoveryIoMode(){
  // Same captured-pipe invariant as the other private modes: both standard
  // handles must be pipes, never redirected regular files.
  if(!IoPipes()){Console.Error.Write("WINDOWS_PRIVATE_IO_UNSAFE");return 1;}
  IoV3Request request=null;
  bool attempted=false;
  bool outputAttempted=false;
  IoV3Outcome outcome=null;
  try{
   request=IoReadV3Request();
   // A commit operates on a stage that already exists once parsed; any later
   // failure is uncertain rather than a clean rejection.
   if(request.Common.Operation=="commit-prepared")attempted=true;
   using(var identity=WindowsIdentity.GetCurrent()){
    string sid=identity.User.Value;
    using(var directories=new IoDirectoryLocks(request.Common,sid)){
     if(request.Common.Operation=="prepare")outcome=IoV3Prepare(request,sid,directories,ref attempted);
     else if(request.Common.Operation=="commit-prepared")outcome=IoV3Commit(request,sid,directories,ref attempted);
     else if(request.Common.Operation=="read-missing")outcome=IoV3Missing(request,sid,directories);
     else outcome=IoV3Read(request,sid,directories);
    }
   }
  }catch{
   // Disposal failures land here too: every owned handle scope has ended (or
   // failed to), and only an outcome assembled afterwards may be emitted.
   if(request!=null){
    try{outcome=IoV3FailureOutcome(request,attempted?"UNKNOWN":"REJECTED");}catch{outcome=null;}
   }else outcome=null;
  }
  if(outcome==null){Console.Error.Write("WINDOWS_PRIVATE_IO_UNSAFE");return attempted||outputAttempted?3:1;}
  try{return IoV3Output(outcome,ref outputAttempted);}
  catch{Console.Error.Write("WINDOWS_PRIVATE_IO_UNSAFE");return 3;}
 }
}
