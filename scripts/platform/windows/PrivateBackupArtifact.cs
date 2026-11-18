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
// Shared-backup artifact export is its own binary publication contract under
// profile FOLIO_SHARED_BACKUP_ARTIFACT_V1 (never recovery v3, never
// publication v1/v2, never the old retained-hardlink v1). The wire is binary:
// [u32LE JSON-header length][ASCII JSON header][exact payload bytes]. The
// header always carries contractVersion=1 and the profile; the payload is the
// full original for BOTH prepare and commit-prepared, so commit can prove the
// staged bytes identical before and after the no-replace rename rather than
// comparing digests alone. Responses use the same frame; the response payload
// is the exact same-handle readback. Everything else reuses the locked-
// ancestor, same-handle proof and captured-pipe primitives from the main
// program file (the parent declares it partial and adds the CLI dispatch).
internal static partial class PrivateRootProbeProgram {
 const int BackupArtifactMaxPayloadBytes=256*1024*1024;
 const int BackupArtifactMaxHeaderBytes=8192;
 const int BackupArtifactMaxStdinBytes=4+BackupArtifactMaxHeaderBytes+BackupArtifactMaxPayloadBytes;
 const int BackupArtifactMaxOutputBytes=4+BackupArtifactMaxHeaderBytes+BackupArtifactMaxPayloadBytes;
 const string BackupArtifactProfile="FOLIO_SHARED_BACKUP_ARTIFACT_V1";
 sealed class BackupArtifactRequest {
  public IoRequest Common;
  public long ByteLength;
  public byte[] Payload;
 }
 sealed class BackupArtifactOutcome {
  public object Response;
  public byte[] Payload;
  public int Status;
 }
 // Read the bounded header, then precisely the declared payload and one EOF
 // byte. No MemoryStream growth or second full-size frame copy is needed.
 static BackupArtifactRequest BackupArtifactReadRequest(){
  using var input=Console.OpenStandardInput();
  byte[] prefix=new byte[4];
  input.ReadExactly(prefix);
  int headerLength=prefix[0]|(prefix[1]<<8)|(prefix[2]<<16)|(prefix[3]<<24);
  IoRequire(headerLength>0&&headerLength<=BackupArtifactMaxHeaderBytes);
  byte[] headerBytes=new byte[headerLength];
  input.ReadExactly(headerBytes);
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
  IoRequire(operation=="prepare"||operation=="commit-prepared");
  var names=new HashSet<string>(new[]{"contractVersion","profile","operation","path","root","rootFileId","rootVolumeId","directoryFileId","directoryVolumeId"},StringComparer.Ordinal);
  if(operation=="prepare")names.UnionWith(new[]{"attemptId","stagingPath","byteLength","sha256"});
  else names.UnionWith(new[]{"attemptId","stagingPath","fileId","volumeId","byteLength","expectedSha256"});
  IoRequire(fields.Count==names.Count);
  foreach(string name in fields.Keys)IoRequire(names.Contains(name));
  IoRequire(IoInteger(fields["contractVersion"])==1);
  IoRequire(IoString(fields["profile"])==BackupArtifactProfile);
  var r=new IoRequest {
   Operation=operation,Path=IoCanonical(IoString(fields["path"])),Root=IoCanonical(IoString(fields["root"])),
   RootFileId=IoHex(fields["rootFileId"],32),RootVolumeId=IoHex(fields["rootVolumeId"],16),
   DirectoryFileId=IoHex(fields["directoryFileId"],32),DirectoryVolumeId=IoHex(fields["directoryVolumeId"],16)
  };
  RelativeDirectorySegments(r.Path,r.Root); // Strict descendant; no root-as-file.
  r.Parent=IoCanonical(System.IO.Path.GetDirectoryName(r.Path));
  IoRequire(Same(r.DirectoryVolumeId,r.RootVolumeId));
  if(Same(r.Parent,r.Root))IoRequire(Same(r.DirectoryFileId,r.RootFileId));
  var request=new BackupArtifactRequest {Common=r};
  r.AttemptId=IoHex(fields["attemptId"],32,true);
  r.StagingPath=IoCanonical(IoString(fields["stagingPath"]));
  RelativeDirectorySegments(r.StagingPath,r.Root);
  IoRequire(Same(IoCanonical(System.IO.Path.GetDirectoryName(r.StagingPath)),r.Parent));
  IoRequire(!Same(r.Path,r.StagingPath));
  IoRequire(fields["byteLength"].ValueKind==JsonValueKind.Number);
  request.ByteLength=fields["byteLength"].GetInt64();
  IoRequire(request.ByteLength>=0&&request.ByteLength<=BackupArtifactMaxPayloadBytes);
  int payloadLength=checked((int)request.ByteLength);
  request.Payload=new byte[payloadLength];
  input.ReadExactly(request.Payload);
  IoRequire(input.ReadByte()==-1);
  if(operation=="prepare"){
   r.ExpectedSha256=IoHex(fields["sha256"],64,true);
   // Hash and canonical identity are proven BEFORE any CREATE_NEW.
   IoRequire(IoSha256(request.Payload)==r.ExpectedSha256);
  }else{
   r.FileId=IoHex(fields["fileId"],32);
   r.VolumeId=IoHex(fields["volumeId"],16);
   r.ExpectedSha256=IoHex(fields["expectedSha256"],64,true);
   IoRequire(Same(r.VolumeId,r.RootVolumeId));
   // The commit wire carries the original payload; its hash must match too.
   IoRequire(IoSha256(request.Payload)==r.ExpectedSha256);
  }
  return request;
 }
 static BackupArtifactOutcome BackupArtifactFailureOutcome(BackupArtifactRequest request,string state){
  IoRequest r=request.Common;
  string reason=state=="EXISTS"?"BACKUP_ARTIFACT_EXISTS":state=="UNKNOWN"?"BACKUP_ARTIFACT_UNKNOWN":"BACKUP_ARTIFACT_REJECTED";
  int status=state=="EXISTS"?2:state=="UNKNOWN"?3:1;
  return new BackupArtifactOutcome {Status=status,Payload=new byte[0],Response=new {contractVersion=1,profile=BackupArtifactProfile,operation=r.Operation,path=r.Path,root=r.Root,attemptId=r.AttemptId,stagingPath=r.StagingPath,state,reason}};
 }
 // Writes the private stage under the locked ancestors, proves it, flushes
 // and read-backs the exact payload on the SAME handle; it never renames.
 // Publication is only the paired commit-prepared operation.
 static BackupArtifactOutcome BackupArtifactPrepare(BackupArtifactRequest request,string sid,IoDirectoryLocks directories,ref bool attempted){
  IoRequest r=request.Common;
  byte[] payload=request.Payload;
  directories.RecheckExclusive();
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
  if(stage.IsInvalid)return BackupArtifactFailureOutcome(request,lastError==80||lastError==183?"EXISTS":"UNKNOWN");
  using(stage){
   var stagingProof=IoFileProof(stage,r.StagingPath,r,sid,0,null);
   IoAclProof(stage,sid,true);
   IoNtfsProof(stage);
   using(var stream=new FileStream(stage,FileAccess.ReadWrite,4096,false)){
    stream.Write(payload,0,payload.Length);
    stream.Flush(true);
    byte[] readback=IoReadExact(stream,payload.Length,BackupArtifactMaxPayloadBytes);
    // Exact same-handle readback equality, not merely a digest comparison.
    IoRequire(System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(payload,readback));
    string sha256=IoSha256(readback);
    var file=IoFileProof(stage,r.StagingPath,r,sid,payload.Length,stagingProof.fileId);
    IoAclProof(stage,sid,true);
    IoNtfsProof(stage);
    var directory=directories.RecheckExclusive();
    return new BackupArtifactOutcome {Status=0,Payload=readback,Response=new {
     contractVersion=1,profile=BackupArtifactProfile,operation=r.Operation,path=r.Path,root=r.Root,attemptId=r.AttemptId,stagingPath=r.StagingPath,state="PREPARED",
     file=IoEvidence(file,sid),directory=IoEvidence(directory,sid),byteLength=payload.Length,sha256,
     contentFlushed=true,filesystem="NTFS"
    }};
   }
  }
 }
 // Reopens the exact caller stage under the same locks, proves it, then proves
 // the stage bytes identical to the wire payload BEFORE the exclusive
 // no-replace rename and the final readback identical AFTER it. A collision
 // keeps the stage.
 static BackupArtifactOutcome BackupArtifactCommit(BackupArtifactRequest request,string sid,IoDirectoryLocks directories,ref bool attempted){
  IoRequest r=request.Common;
  attempted=true; // The stage exists once this request parses; no retry.
  directories.RecheckExclusive();
  IntPtr raw=CreateFileW(r.StagingPath,IoGenericRead|IoGenericWrite|IoDeleteAccess|IoReadControl,IoShareRead,IntPtr.Zero,OpenExisting,FileFlagOpenReparsePoint|IoWriteThrough,IntPtr.Zero);
  IoRequire(raw!=new IntPtr(-1));
  using(var handle=new SafeFileHandle(raw,true)){
   IoAclProof(handle,sid,true);
   IoNtfsProof(handle);
   var stagingProof=IoFileProof(handle,r.StagingPath,r,sid,request.ByteLength,r.FileId);
   IoRequire(Same(stagingProof.volumeId,r.VolumeId));
   int length=checked((int)request.ByteLength);
   using(var stream=new FileStream(handle,FileAccess.ReadWrite,4096,false)){
    byte[] bytes=IoReadExact(stream,length,BackupArtifactMaxPayloadBytes);
    string sha256=IoSha256(bytes);
    IoRequire(System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(Convert.FromHexString(sha256),Convert.FromHexString(r.ExpectedSha256)));
    IoRequire(System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(bytes,request.Payload));
    directories.RecheckExclusive();
    if(!IoRenameNoReplace(handle,r.Path,out int error)){
     directories.RecheckExclusive();
     return BackupArtifactFailureOutcome(request,error==80||error==183?"EXISTS":"UNKNOWN");
    }
    stream.Flush(true);
    byte[] finalReadback=IoReadExact(stream,length,BackupArtifactMaxPayloadBytes);
    IoRequire(System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(finalReadback,request.Payload));
    var file=IoFileProof(handle,r.Path,r,sid,length,stagingProof.fileId);
    IoAclProof(handle,sid,true);
    IoNtfsProof(handle);
    var directory=directories.RecheckExclusive();
    return new BackupArtifactOutcome {Status=0,Payload=finalReadback,Response=new {
     contractVersion=1,profile=BackupArtifactProfile,operation=r.Operation,path=r.Path,root=r.Root,attemptId=r.AttemptId,stagingPath=r.StagingPath,state="PUBLISHED",
     file=IoEvidence(file,sid),directory=IoEvidence(directory,sid),byteLength=length,sha256,
     contentFlushed=true,filesystem="NTFS",
     stagingDisposition="RENAMED_TO_FINAL",@namespace="EXCLUSIVE_NO_REPLACE",
     durability=new {profile="WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1",scope="PROCESS_CRASH"}
    }};
   }
  }
 }
 // Captured-pipe binary output. The response object is serialized as the ASCII
 // JSON header; the payload follows unencoded. Assembled outcomes are emitted
 // only after every owned handle scope has disposed.
 static int BackupArtifactOutput(BackupArtifactOutcome outcome,ref bool outputAttempted){
  IoRequire(IoPipes());
  byte[] header=JsonSerializer.SerializeToUtf8Bytes(outcome.Response,new JsonSerializerOptions {
   Encoder=System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping
  });
  IoRequire(header.Length>0&&header.Length<=BackupArtifactMaxHeaderBytes);
  foreach(byte b in header)IoRequire(b<0x80);
  byte[] payload=outcome.Payload??new byte[0];
  IoRequire(4+header.Length+payload.Length<=BackupArtifactMaxOutputBytes);
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
 static int PrivateBackupArtifactMode(){
  // Same captured-pipe invariant as the other private modes: both standard
  // handles must be pipes, never redirected regular files.
  if(!IoPipes()){Console.Error.Write("WINDOWS_PRIVATE_IO_UNSAFE");return 1;}
  BackupArtifactRequest request=null;
  bool attempted=false;
  bool outputAttempted=false;
  BackupArtifactOutcome outcome=null;
  try{
   request=BackupArtifactReadRequest();
   // A commit operates on a stage that already exists once parsed; any later
   // failure is uncertain rather than a clean rejection.
   if(request.Common.Operation=="commit-prepared")attempted=true;
   using(var identity=WindowsIdentity.GetCurrent()){
    string sid=identity.User.Value;
    using(var directories=new IoDirectoryLocks(request.Common,sid)){
     if(request.Common.Operation=="prepare")outcome=BackupArtifactPrepare(request,sid,directories,ref attempted);
     else outcome=BackupArtifactCommit(request,sid,directories,ref attempted);
    }
   }
  }catch{
   // Disposal failures land here too: every owned handle scope has ended (or
   // failed to), and only an outcome assembled afterwards may be emitted.
   if(request!=null){
    try{outcome=BackupArtifactFailureOutcome(request,attempted?"UNKNOWN":"REJECTED");}catch{outcome=null;}
   }else outcome=null;
  }
  if(outcome==null){Console.Error.Write("WINDOWS_PRIVATE_IO_UNSAFE");return attempted||outputAttempted?3:1;}
  try{return BackupArtifactOutput(outcome,ref outputAttempted);}
  catch{Console.Error.Write("WINDOWS_PRIVATE_IO_UNSAFE");return 3;}
 }
}
