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
// Private persistence I/O v4: single-dispatch native file operations for the
// generic durable writers (attachments, sync binding sidecar, recovery files,
// backup artifacts). Wire is the shared binary frame
// [u32LE JSON-header length][ASCII JSON header][exact payload bytes].
// Reads/inspects return state="OK"; mutations return state="APPLIED" only
// after every proof, and any post-dispatch ambiguity is state="UNKNOWN"
// (status 3) — never an implicit retry, delete, or overwrite.
// All operations run under the locked-ancestor pin walk (IoDirectoryLocks):
// every ancestor from the drive root is held open with no write/delete
// sharing, re-inspected and re-proven before/after the mutation. Two-parent
// operations hold BOTH parent chains simultaneously.
internal static partial class PrivateRootProbeProgram {
 const int PersistenceIoMaxHeaderBytes=8192;
 const int PersistenceIoMaxPayloadBytes=32*1024*1024+4096;
 const int PersistenceIoCopyMaxBytes=256*1024*1024;
 const int PersistenceIoMaxStdinBytes=4+PersistenceIoMaxHeaderBytes+PersistenceIoMaxPayloadBytes;
 const int PersistenceIoMaxOutputBytes=4+PersistenceIoMaxHeaderBytes+PersistenceIoMaxPayloadBytes;
 const int IoFileDispositionInfo=4;
 const int IoChunk=1024*1024;
 sealed class IoV4Request {
  public IoRequest Common;
  public string Destination="";
  public string DestinationParent="";
  public string DestinationDirectoryFileId="";
  public string DestinationDirectoryVolumeId="";
  public long ByteLength;
  public long MaxBytes;
  public int Entries;
  public byte[] Payload;
  public bool HasExpectedSha256;
  public bool HasSourceIdentity;
 }
 sealed class IoV4Outcome {
  public object Response;
  public byte[] Payload;
  public int Status;
 }
 static IoV4Request IoReadV4Request(){
  using var input=Console.OpenStandardInput();
  using var buffer=new MemoryStream();
  byte[] chunk=new byte[8192];
  for(;;){
   int remaining=PersistenceIoMaxStdinBytes+1-(int)buffer.Length;
   int count=input.Read(chunk,0,Math.Min(chunk.Length,remaining));
   if(count==0)break;
   buffer.Write(chunk,0,count);
   IoRequire(buffer.Length<=PersistenceIoMaxStdinBytes);
  }
  byte[] encoded=buffer.ToArray();
  IoRequire(encoded.Length>=4);
  int headerLength=encoded[0]|(encoded[1]<<8)|(encoded[2]<<16)|(encoded[3]<<24);
  IoRequire(headerLength>0&&headerLength<=PersistenceIoMaxHeaderBytes&&encoded.Length>=4+headerLength);
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
  IoRequire(operation=="inspect-directory"||operation=="inspect-file-identity"||operation=="inspect-file"||
   operation=="read"||operation=="write-new"||operation=="copy-new"||operation=="rename-new"||
   operation=="unlink-exact"||operation=="prove-sync"||operation=="inspect-tree"||operation=="rename-directory-new");
  bool mutating=operation=="write-new"||operation=="copy-new"||operation=="rename-new"||
   operation=="unlink-exact"||operation=="prove-sync"||operation=="rename-directory-new";
  var names=new HashSet<string>(new[]{"contractVersion","operation","path","root","rootFileId","rootVolumeId","directoryFileId","directoryVolumeId"},StringComparer.Ordinal);
  if(mutating)names.Add("attemptId");
  if(operation=="write-new")names.UnionWith(new[]{"byteLength","sha256","maxBytes"});
  else if(operation=="inspect-file")names.Add("maxBytes");
  else if(operation=="read")names.UnionWith(new[]{"fileId","volumeId","expectedSha256","maxBytes"});
  else if(operation=="copy-new"||operation=="rename-new")
   names.UnionWith(new[]{"destination","destinationDirectoryFileId","destinationDirectoryVolumeId","sourceFileId","sourceVolumeId","sourceSha256","byteLength","maxBytes"});
  else if(operation=="rename-directory-new")
   names.UnionWith(new[]{"destination","destinationDirectoryFileId","destinationDirectoryVolumeId","sourceFileId","sourceVolumeId","sourceSha256","byteLength","entries"});
  else if(operation=="unlink-exact"||operation=="prove-sync")
   names.UnionWith(new[]{"fileId","volumeId","expectedSha256","byteLength"});
  if(operation=="unlink-exact")names.Add("maxBytes");
  IoRequire(fields.Count==names.Count);
  foreach(string name in fields.Keys)IoRequire(names.Contains(name));
  IoRequire(IoInteger(fields["contractVersion"])==4);
  var r=new IoRequest {
   Operation=operation,Path=IoCanonical(IoString(fields["path"])),Root=IoCanonical(IoString(fields["root"])),
   RootFileId=IoHex(fields["rootFileId"],32),RootVolumeId=IoHex(fields["rootVolumeId"],16),
   DirectoryFileId=IoHex(fields["directoryFileId"],32),DirectoryVolumeId=IoHex(fields["directoryVolumeId"],16)
  };
  RelativeDirectorySegments(r.Path,r.Root);
  r.Parent=IoCanonical(System.IO.Path.GetDirectoryName(r.Path));
  IoRequire(Same(r.DirectoryVolumeId,r.RootVolumeId));
  if(Same(r.Parent,r.Root))IoRequire(Same(r.DirectoryFileId,r.RootFileId));
  int payloadLength=encoded.Length-4-headerLength;
  var request=new IoV4Request {Common=r};
  if(mutating)r.AttemptId=IoHex(fields["attemptId"],32,true);
  if(operation=="write-new"){
   r.ExpectedSha256=IoHex(fields["sha256"],64,true);
   request.ByteLength=fields["byteLength"].GetInt64();
   request.MaxBytes=fields["maxBytes"].GetInt64();
   IoRequire(request.ByteLength>=0&&request.ByteLength<=PersistenceIoMaxPayloadBytes&&request.ByteLength==payloadLength);
   IoRequire(request.MaxBytes>=0&&request.MaxBytes<=PersistenceIoMaxPayloadBytes&&request.ByteLength<=request.MaxBytes);
   request.Payload=new byte[payloadLength];
   Array.Copy(encoded,4+headerLength,request.Payload,0,payloadLength);
   IoRequire(IoSha256(request.Payload)==r.ExpectedSha256);
  }else{
   IoRequire(payloadLength==0);
  }
  if(operation=="inspect-file"){
   request.MaxBytes=fields["maxBytes"].GetInt64();
   IoRequire(request.MaxBytes>=0&&request.MaxBytes<=PersistenceIoCopyMaxBytes);
  }
  if(operation=="read"){
   r.FileId=IoHex(fields["fileId"],32);
   r.VolumeId=IoHex(fields["volumeId"],16);
   r.ExpectedSha256=IoHex(fields["expectedSha256"],64,true);request.HasExpectedSha256=true;
   request.MaxBytes=fields["maxBytes"].GetInt64();
   IoRequire(request.MaxBytes>=0&&request.MaxBytes<=PersistenceIoMaxPayloadBytes&&Same(r.VolumeId,r.RootVolumeId));
  }
  if(operation=="copy-new"||operation=="rename-new"||operation=="rename-directory-new"){
   request.Destination=IoCanonical(IoString(fields["destination"]));
   RelativeDirectorySegments(request.Destination,r.Root);
   IoRequire(!Same(request.Destination,r.Path));
   request.DestinationParent=IoCanonical(System.IO.Path.GetDirectoryName(request.Destination));
   request.DestinationDirectoryFileId=IoHex(fields["destinationDirectoryFileId"],32);
   request.DestinationDirectoryVolumeId=IoHex(fields["destinationDirectoryVolumeId"],16);
   IoRequire(Same(request.DestinationDirectoryVolumeId,r.RootVolumeId));
   if(Same(request.DestinationParent,r.Root))IoRequire(Same(request.DestinationDirectoryFileId,r.RootFileId));
   r.FileId=IoHex(fields["sourceFileId"],32);
   r.VolumeId=IoHex(fields["sourceVolumeId"],16);
   r.ExpectedSha256=IoHex(fields["sourceSha256"],64,true);request.HasExpectedSha256=true;
   request.HasSourceIdentity=true;
   request.ByteLength=fields["byteLength"].GetInt64();
   request.MaxBytes=operation=="rename-directory-new"?PersistenceIoCopyMaxBytes:fields["maxBytes"].GetInt64();
   if(operation=="rename-directory-new"){
    request.Entries=fields["entries"].GetInt32();
    IoRequire(request.Entries>=1&&request.Entries<=4096);
    IoRequire(!r.Path.StartsWith(request.Destination+"\\",StringComparison.OrdinalIgnoreCase)&&
     !request.Destination.StartsWith(r.Path+"\\",StringComparison.OrdinalIgnoreCase));
   }
   IoRequire(request.ByteLength>=0&&request.ByteLength<=PersistenceIoCopyMaxBytes&&request.ByteLength<=request.MaxBytes&&request.MaxBytes<=PersistenceIoCopyMaxBytes&&Same(r.VolumeId,r.RootVolumeId));
  }
  if(operation=="unlink-exact"||operation=="prove-sync"){
   r.FileId=IoHex(fields["fileId"],32);
   r.VolumeId=IoHex(fields["volumeId"],16);
   r.ExpectedSha256=IoHex(fields["expectedSha256"],64,true);request.HasExpectedSha256=true;
   request.ByteLength=fields["byteLength"].GetInt64();
   IoRequire(request.ByteLength>=0&&request.ByteLength<=PersistenceIoCopyMaxBytes&&Same(r.VolumeId,r.RootVolumeId));
   if(operation=="unlink-exact"){
    request.MaxBytes=fields["maxBytes"].GetInt64();
    IoRequire(request.MaxBytes>=0&&request.MaxBytes<=PersistenceIoCopyMaxBytes&&request.ByteLength<=request.MaxBytes);
   }
  }
  return request;
 }
 static IoV4Outcome IoV4FailureOutcome(IoV4Request request,string state){
  IoRequest r=request.Common;
  string reason=state=="EXISTS"?"PRIVATE_PERSISTENCE_EXISTS":state=="UNKNOWN"?"PRIVATE_PERSISTENCE_UNKNOWN":"PRIVATE_PERSISTENCE_REJECTED";
  int status=state=="EXISTS"?2:state=="UNKNOWN"?3:1;
  if(r.AttemptId.Length>0)
   return new IoV4Outcome {Status=status,Payload=new byte[0],Response=new {contractVersion=4,operation=r.Operation,path=r.Path,root=r.Root,attemptId=r.AttemptId,state,reason}};
  return new IoV4Outcome {Status=status,Payload=new byte[0],Response=new {contractVersion=4,operation=r.Operation,path=r.Path,root=r.Root,state,reason}};
 }
 static object IoV4Durability(){
  return new {profile="WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1",scope="PROCESS_CRASH"};
 }
 // Incremental same-handle hash/EOF proof for streaming paths: reads the held
 // handle in <=1MiB chunks and proves exact length+hash.
 static string IoStreamHash(FileStream stream,long expected,int maximum){
  IoRequire(expected>=0&&expected<=maximum);
  stream.Position=0;
  using var hash=IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
  byte[] buffer=new byte[IoChunk];
  long total=0;
  for(;;){
   int count=stream.Read(buffer,0,buffer.Length);
   if(count==0)break;
   hash.AppendData(buffer,0,count);
   total+=count;
   IoRequire(total<=maximum);
  }
  IoRequire(total==expected&&stream.Length==expected);
  return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
 }
 static IoV4Outcome IoV4InspectDirectory(IoV4Request request,string sid,IoDirectoryLocks directories){
  IoRequest r=request.Common;
  IntPtr raw=CreateFileW(r.Path,FileReadAttributes|IoReadControl,IoShareRead,IntPtr.Zero,OpenExisting,FileFlagBackupSemantics|FileFlagOpenReparsePoint,IntPtr.Zero);
  IoRequire(raw!=new IntPtr(-1));
  using(var handle=new SafeFileHandle(raw,true)){
   IoInspect(handle,true);
   var target=IoProof(handle,r.Path,r,sid);
   IoAclProof(handle,sid,false);
   IoNtfsProof(handle);
   var directory=directories.Recheck();
   return new IoV4Outcome {Status=0,Payload=new byte[0],Response=new {
    contractVersion=4,operation=r.Operation,path=r.Path,root=r.Root,state="OK",
    file=IoEvidence(target,sid),directory=IoEvidence(directory,sid)
   }};
  }
 }
 static IoV4Outcome IoV4InspectIdentity(IoV4Request request,string sid,IoDirectoryLocks directories){
  IoRequest r=request.Common;
  // Metadata-only: READ_ATTRIBUTES with READ|WRITE sharing, never DELETE
  // sharing, so an open SQLite database can be identity-pinned without a
  // byte-consistency assertion.
  IntPtr raw=CreateFileW(r.Path,FileReadAttributes|IoReadControl,FileShareReadWrite,IntPtr.Zero,OpenExisting,FileFlagOpenReparsePoint,IntPtr.Zero);
  IoRequire(raw!=new IntPtr(-1));
  using(var handle=new SafeFileHandle(raw,true)){
   IoInspect(handle,false);
   IoAclProof(handle,sid,false);
   IoNtfsProof(handle);
   var target=IoProof(handle,r.Path,r,sid);
   var directory=directories.Recheck();
   return new IoV4Outcome {Status=0,Payload=new byte[0],Response=new {
    contractVersion=4,operation=r.Operation,path=r.Path,root=r.Root,state="OK",
    file=IoEvidence(target,sid),directory=IoEvidence(directory,sid)
   }};
  }
 }
 // A finite, held inventory. Enumeration discovers names only: each name is
 // proved against its retained handle. No content is buffered and no child
 // handle is released until the entire operation (including rename) ends.
 sealed class IoTreeEntry:IDisposable {
  public string Relative,FileId,VolumeId,Hash;
  public bool Directory;
  public long Bytes;
  public SafeFileHandle Handle;
  public FileStream Stream;
  public void Dispose(){try{if(Stream!=null)Stream.Dispose();}finally{if(Handle!=null)Handle.Dispose();}}
 }
 sealed class IoHeldTree:IDisposable {
  public readonly List<IoTreeEntry> Entries=new List<IoTreeEntry>();
  readonly IoRequest request;
  readonly string sid;
  public long Bytes;
  public string Hash;
  public IoHeldTree(IoRequest r,string currentSid,bool rename){
   request=r;sid=currentSid;
   try{
    Add(r.Path,"",0,true,rename);
    Entries.Sort((a,b)=>StringComparer.Ordinal.Compare(a.Relative,b.Relative));
    using(var hash=IncrementalHash.CreateHash(HashAlgorithmName.SHA256)){
     foreach(var e in Entries){
      string record=e.Directory?"D\0"+e.Relative+"\0"+e.FileId+"\0"+e.VolumeId+"\n":
       "F\0"+e.Relative+"\0"+e.FileId+"\0"+e.VolumeId+"\0"+
       e.Bytes.ToString(System.Globalization.CultureInfo.InvariantCulture)+"\0"+e.Hash+"\n";
      hash.AppendData(System.Text.Encoding.UTF8.GetBytes(record));
     }
     Hash=Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
    }
    Recheck(r.Path);
   }catch(Exception error){
    try{Dispose();}catch(Exception cleanup){throw new AggregateException(error,cleanup);}
    throw;
   }
  }
  void Add(string path,string relative,int depth,bool directory,bool rename){
   IoRequire(depth<=64&&Entries.Count<4096);
   // Canonical paths and canonical ASCII record names exclude separators,
   // controls and case-fold aliases before any unbounded inventory allocation.
   path=IoCanonical(path);
   uint access=directory?FileReadAttributes|IoReadControl:IoGenericRead|IoReadControl;
   if(rename)access|=IoDeleteAccess;
   IntPtr raw=CreateFileW(path,access,IoShareRead,IntPtr.Zero,OpenExisting,
    FileFlagOpenReparsePoint|(directory?FileFlagBackupSemantics:0),IntPtr.Zero);
   IoRequire(raw!=new IntPtr(-1));
   var e=new IoTreeEntry {Relative=relative,Directory=directory,Handle=new SafeFileHandle(raw,true)};
   Entries.Add(e); // disposal ownership established before any further proof
   var info=IoInspect(e.Handle,directory);
   IoAclProof(e.Handle,sid,false);IoNtfsProof(e.Handle);
   var proof=IoProof(e.Handle,path,request,sid);
   e.FileId=proof.fileId.ToLowerInvariant();e.VolumeId=proof.volumeId.ToLowerInvariant();
   if(directory){
    var names=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    foreach(string child in Directory.EnumerateFileSystemEntries(path)){
     IoRequire(Entries.Count<4096);
     string name=System.IO.Path.GetFileName(child);
     IoRequire(name.Length>0&&names.Add(name));
     foreach(char c in name)IoRequire(c>=32&&c<=126&&c!='/'&&c!='\\');
     // The attribute is discovery only; IoInspect on the held handle proves it.
     bool childDirectory=(File.GetAttributes(child)&FileAttributes.Directory)!=0;
     Add(child,relative.Length==0?name:relative+"/"+name,depth+1,childDirectory,false);
    }
   }else{
    e.Bytes=info.EndOfFile;
    IoRequire(e.Bytes<=PersistenceIoCopyMaxBytes&&Bytes<=PersistenceIoCopyMaxBytes-e.Bytes);
    Bytes+=e.Bytes;
    e.Stream=new FileStream(e.Handle,FileAccess.Read,4096,false);
    e.Hash=IoStreamHash(e.Stream,e.Bytes,PersistenceIoCopyMaxBytes);
   }
  }
  public FolioWindowsProbeResult Recheck(string root){
   var known=new Dictionary<string,IoTreeEntry>(StringComparer.Ordinal);
   foreach(var e in Entries)known.Add(e.Relative,e);
   var seen=new HashSet<string>(StringComparer.Ordinal);
   Reenumerate(root,"",0,known,seen);
   IoRequire(seen.Count==Entries.Count);
   FolioWindowsProbeResult rootProof=null;
   foreach(var e in Entries){
    string path=e.Relative.Length==0?root:System.IO.Path.Combine(root,e.Relative.Replace('/','\\'));
    var info=IoInspect(e.Handle,e.Directory);
    IoAclProof(e.Handle,sid,false);IoNtfsProof(e.Handle);
    var proof=IoProof(e.Handle,path,request,sid);
    IoRequire(Same(proof.fileId,e.FileId)&&Same(proof.volumeId,e.VolumeId));
    if(!e.Directory)IoRequire(info.EndOfFile==e.Bytes&&IoStreamHash(e.Stream,e.Bytes,PersistenceIoCopyMaxBytes)==e.Hash);
    if(e.Relative.Length==0)rootProof=proof;
   }
   return rootProof;
  }
  void Reenumerate(string path,string relative,int depth,Dictionary<string,IoTreeEntry> known,HashSet<string> seen){
   IoRequire(depth<=64&&seen.Count<4096&&known.ContainsKey(relative)&&seen.Add(relative));
   if(!known[relative].Directory)return;
   var names=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
   foreach(string child in Directory.EnumerateFileSystemEntries(path)){
    IoRequire(seen.Count<4096);
    string name=System.IO.Path.GetFileName(child);
    IoRequire(names.Add(name));
    Reenumerate(child,relative.Length==0?name:relative+"/"+name,depth+1,known,seen);
   }
  }
  public IoTreeEntry Root {get{return Entries[0];}}
  public void Dispose(){
   var failures=new List<Exception>();
   foreach(var e in Entries){try{e.Dispose();}catch(Exception error){failures.Add(error);}}
   if(failures.Count>0)throw new AggregateException(failures);
  }
 }
 static IoV4Outcome IoV4Tree(IoV4Request request,string sid,IoDirectoryLocks directories,
  IoDirectoryLocks destinationDirectories,ref bool attempted){
  IoRequest r=request.Common;
  bool rename=r.Operation=="rename-directory-new";
  using(var tree=new IoHeldTree(r,sid,rename)){
   var file=tree.Recheck(r.Path);
   var directory=directories.Recheck();
   if(!rename)return new IoV4Outcome {Status=0,Payload=new byte[0],Response=new {
    contractVersion=4,operation=r.Operation,path=r.Path,root=r.Root,state="OK",
    file=IoEvidence(file,sid),directory=IoEvidence(directory,sid),entries=tree.Entries.Count,
    byteLength=tree.Bytes,sha256=tree.Hash,filesystem="NTFS"
   }};
   IoRequire(Same(file.fileId,r.FileId)&&Same(file.volumeId,r.VolumeId)&&
    tree.Hash==r.ExpectedSha256&&tree.Bytes==request.ByteLength&&tree.Entries.Count==request.Entries);
   IoRequire(Same(file.volumeId,request.DestinationDirectoryVolumeId));
   destinationDirectories.Recheck();
   tree.Recheck(r.Path);
   attempted=true;
   // Any native-call failure after attempted=true is UNKNOWN, including a
   // raced collision. Never retry, remove a wrapper or copy/delete fallback.
   IoRequire(IoRenameNoReplace(tree.Root.Handle,request.Destination,out _));
   file=tree.Recheck(request.Destination);
   directory=destinationDirectories.Recheck();
   var sourceDirectory=directories.Recheck();
   return new IoV4Outcome {Status=0,Payload=new byte[0],Response=new {
    contractVersion=4,operation=r.Operation,path=r.Path,root=r.Root,attemptId=r.AttemptId,state="APPLIED",
    destination=request.Destination,file=IoEvidence(file,sid),directory=IoEvidence(directory,sid),
    sourceDirectory=IoEvidence(sourceDirectory,sid),entries=tree.Entries.Count,byteLength=tree.Bytes,
    sha256=tree.Hash,filesystem="NTFS",
    durability=new {profile="WINDOWS_LOCAL_NTFS_DIRECTORY_RENAME_V1",scope="PROCESS_CRASH"}
   }};
  }
 }
 static IoV4Outcome IoV4InspectFile(IoV4Request request,string sid,IoDirectoryLocks directories){
  IoRequest r=request.Common;
  IntPtr raw=CreateFileW(r.Path,IoGenericRead|IoReadControl,IoShareRead,IntPtr.Zero,OpenExisting,FileFlagOpenReparsePoint,IntPtr.Zero);
  IoRequire(raw!=new IntPtr(-1));
  using(var handle=new SafeFileHandle(raw,true)){
   var standard=IoInspect(handle,false);
   IoRequire(standard.EndOfFile<=request.MaxBytes);
   IoAclProof(handle,sid,false);
   IoNtfsProof(handle);
   IoFileProof(handle,r.Path,r,sid,standard.EndOfFile,null);
   using(var stream=new FileStream(handle,FileAccess.Read,4096,false)){
    string sha256=IoStreamHash(stream,standard.EndOfFile,(int)Math.Min(request.MaxBytes,(long)int.MaxValue));
    var file=IoFileProof(handle,r.Path,r,sid,standard.EndOfFile,null);
    var directory=directories.Recheck();
    return new IoV4Outcome {Status=0,Payload=new byte[0],Response=new {
     contractVersion=4,operation=r.Operation,path=r.Path,root=r.Root,state="OK",
     file=IoEvidence(file,sid),directory=IoEvidence(directory,sid),
     byteLength=standard.EndOfFile,sha256,filesystem="NTFS"
    }};
   }
  }
 }
 static IoV4Outcome IoV4Read(IoV4Request request,string sid,IoDirectoryLocks directories){
  IoRequest r=request.Common;
  IntPtr raw=CreateFileW(r.Path,IoGenericRead|IoReadControl,IoShareRead,IntPtr.Zero,OpenExisting,FileFlagOpenReparsePoint,IntPtr.Zero);
  IoRequire(raw!=new IntPtr(-1));
  using(var handle=new SafeFileHandle(raw,true)){
   var standard=IoInspect(handle,false);
   IoRequire(standard.EndOfFile<=request.MaxBytes);
   int length=checked((int)standard.EndOfFile);
   IoAclProof(handle,sid,false);
   IoNtfsProof(handle);
   IoFileProof(handle,r.Path,r,sid,length,r.FileId);
   using(var stream=new FileStream(handle,FileAccess.Read,4096,false)){
    byte[] bytes=IoReadExact(stream,length,PersistenceIoMaxPayloadBytes);
    string sha256=IoSha256(bytes);
    IoRequire(CryptographicOperations.FixedTimeEquals(Convert.FromHexString(sha256),Convert.FromHexString(r.ExpectedSha256)));
    var file=IoFileProof(handle,r.Path,r,sid,length,r.FileId);
    IoAclProof(handle,sid,false);
    IoNtfsProof(handle);
    var directory=directories.Recheck();
    return new IoV4Outcome {Status=0,Payload=bytes,Response=new {
     contractVersion=4,operation=r.Operation,path=r.Path,root=r.Root,state="OK",
     file=IoEvidence(file,sid),directory=IoEvidence(directory,sid),
     byteLength=length,sha256,filesystem="NTFS"
    }};
   }
  }
 }
 // Exclusive CREATE_NEW under a protected owner-only DACL on the held handle;
 // bytes are written, flushed (data+metadata), and re-proven by exact
 // same-handle readback+hash before APPLIED is emitted.
 static IoV4Outcome IoV4WriteNew(IoV4Request request,string sid,IoDirectoryLocks directories,ref bool attempted){
  IoRequest r=request.Common;
  byte[] payload=request.Payload;
  IntPtr descriptor=IntPtr.Zero;
  int lastError=0;
  SafeFileHandle created;
  try{
   string sddl="O:"+sid+"G:"+sid+"D:P(A;;FA;;;"+sid+")";
   IoRequire(IoConvertSecurityDescriptor(sddl,1,out descriptor,out _));
   var attributes=new IO_SECURITY_ATTRIBUTES {Length=(uint)Marshal.SizeOf<IO_SECURITY_ATTRIBUTES>(),SecurityDescriptor=descriptor,InheritHandle=false};
   attempted=true; // Even an unsuccessful CREATE_NEW call is conservatively UNKNOWN.
   created=IoCreateFile(r.Path,IoGenericRead|IoGenericWrite|IoDeleteAccess|IoReadControl,IoShareRead,ref attributes,IoCreateNew,FileFlagOpenReparsePoint|IoWriteThrough,IntPtr.Zero);
   lastError=Marshal.GetLastWin32Error();
  }finally{if(descriptor!=IntPtr.Zero)IoLocalFree(descriptor);}
  if(created.IsInvalid)return IoV4FailureOutcome(request,lastError==80||lastError==183?"EXISTS":"UNKNOWN");
  using(created){
   var createProof=IoFileProof(created,r.Path,r,sid,0,null);
   IoAclProof(created,sid,true);
   IoNtfsProof(created);
   using(var stream=new FileStream(created,FileAccess.ReadWrite,4096,false)){
    stream.Write(payload,0,payload.Length);
    stream.Flush(true);
    byte[] readback=IoReadExact(stream,payload.Length,PersistenceIoMaxPayloadBytes);
    string sha256=IoSha256(readback);
    IoRequire(sha256==r.ExpectedSha256);
    var file=IoFileProof(created,r.Path,r,sid,payload.Length,createProof.fileId);
    IoAclProof(created,sid,true);
    IoNtfsProof(created);
    var directory=directories.Recheck();
    return new IoV4Outcome {Status=0,Payload=readback,Response=new {
     contractVersion=4,operation=r.Operation,path=r.Path,root=r.Root,attemptId=r.AttemptId,state="APPLIED",
     file=IoEvidence(file,sid),directory=IoEvidence(directory,sid),
     byteLength=payload.Length,sha256,contentFlushed=true,filesystem="NTFS",
     durability=IoV4Durability()
    }};
   }
  }
 }
 // Streaming copy under held source (READ, no write/delete sharing) and held
 // destination parents: incremental SHA256 while copying in <=1MiB chunks,
 // then same-handle readback/hash/EOF proof on the flushed destination.
 static IoV4Outcome IoV4CopyNew(IoV4Request request,string sid,IoDirectoryLocks directories,IoDirectoryLocks destinationDirectories,ref bool attempted){
  IoRequest r=request.Common;
  IntPtr raw=CreateFileW(r.Path,IoGenericRead|IoReadControl,IoShareRead,IntPtr.Zero,OpenExisting,FileFlagOpenReparsePoint,IntPtr.Zero);
  IoRequire(raw!=new IntPtr(-1));
  using(var source=new SafeFileHandle(raw,true)){
   var standard=IoInspect(source,false);
   IoRequire(standard.EndOfFile==request.ByteLength);
   IoAclProof(source,sid,false);
   IoNtfsProof(source);
   IoFileProof(source,r.Path,r,sid,request.ByteLength,r.FileId);
   IntPtr descriptor=IntPtr.Zero;
   int lastError=0;
   SafeFileHandle created;
   try{
    string sddl="O:"+sid+"G:"+sid+"D:P(A;;FA;;;"+sid+")";
    IoRequire(IoConvertSecurityDescriptor(sddl,1,out descriptor,out _));
    var attributes=new IO_SECURITY_ATTRIBUTES {Length=(uint)Marshal.SizeOf<IO_SECURITY_ATTRIBUTES>(),SecurityDescriptor=descriptor,InheritHandle=false};
    attempted=true;
    created=IoCreateFile(request.Destination,IoGenericRead|IoGenericWrite|IoDeleteAccess|IoReadControl,IoShareRead,ref attributes,IoCreateNew,FileFlagOpenReparsePoint|IoWriteThrough,IntPtr.Zero);
    lastError=Marshal.GetLastWin32Error();
   }finally{if(descriptor!=IntPtr.Zero)IoLocalFree(descriptor);}
   if(created.IsInvalid)return IoV4FailureOutcome(request,lastError==80||lastError==183?"EXISTS":"UNKNOWN");
   using(created){
    IoFileProof(created,request.Destination,DestRequest(r,request),sid,0,null);
    IoAclProof(created,sid,true);
    IoNtfsProof(created);
    using(var input=new FileStream(source,FileAccess.Read,4096,false))
    using(var output=new FileStream(created,FileAccess.ReadWrite,4096,false)){
     input.Position=0;
     using(var hash=IncrementalHash.CreateHash(HashAlgorithmName.SHA256)){
      byte[] buffer=new byte[IoChunk];
      long total=0;
      for(;;){
       int count=input.Read(buffer,0,buffer.Length);
       if(count==0)break;
       hash.AppendData(buffer,0,count);
       output.Write(buffer,0,count);
       total+=count;
       IoRequire(total<=PersistenceIoCopyMaxBytes);
      }
      IoRequire(total==request.ByteLength&&input.Length==request.ByteLength);
      string sourceHash=Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
      IoRequire(CryptographicOperations.FixedTimeEquals(Convert.FromHexString(sourceHash),Convert.FromHexString(r.ExpectedSha256)));
      output.Flush(true);
      byte[] verify=new byte[0];
      string readbackHash=IoStreamHash(output,request.ByteLength,PersistenceIoCopyMaxBytes);
      IoRequire(CryptographicOperations.FixedTimeEquals(Convert.FromHexString(readbackHash),Convert.FromHexString(r.ExpectedSha256)));
      var file=IoFileProof(created,request.Destination,DestRequest(r,request),sid,request.ByteLength,null);
      IoAclProof(created,sid,true);
      IoNtfsProof(created);
      var directory=destinationDirectories.Recheck();
      var sourceDirectory=directories.Recheck();
      return new IoV4Outcome {Status=0,Payload=verify,Response=new {
       contractVersion=4,operation=r.Operation,path=r.Path,root=r.Root,attemptId=r.AttemptId,state="APPLIED",
       destination=request.Destination,
       file=IoEvidence(file,sid),directory=IoEvidence(directory,sid),sourceDirectory=IoEvidence(sourceDirectory,sid),
       byteLength=request.ByteLength,sha256=readbackHash,contentFlushed=true,filesystem="NTFS",
       durability=IoV4Durability()
      }};
     }
    }
   }
  }
 }
 // A second lock request: identical proof requirements, destination parent
 // chain. Root expectations are unchanged (both parents share the private root).
 static IoRequest DestRequest(IoRequest r,IoV4Request request){
  return new IoRequest {
   Operation=r.Operation,Path=request.Destination,Root=r.Root,
   RootFileId=r.RootFileId,RootVolumeId=r.RootVolumeId,
   DirectoryFileId=request.DestinationDirectoryFileId,DirectoryVolumeId=request.DestinationDirectoryVolumeId,
   Parent=request.DestinationParent
  };
 }
 // Held-DELETE-handle rename: identity/hash/size proven on the SAME handle,
 // then no-replace rename on that handle — never check-close-rename.
 static IoV4Outcome IoV4RenameNew(IoV4Request request,string sid,IoDirectoryLocks directories,IoDirectoryLocks destinationDirectories,ref bool attempted){
  IoRequest r=request.Common;
  IntPtr raw=CreateFileW(r.Path,IoGenericRead|IoGenericWrite|IoDeleteAccess|IoReadControl,IoShareRead,IntPtr.Zero,OpenExisting,FileFlagOpenReparsePoint|IoWriteThrough,IntPtr.Zero);
  IoRequire(raw!=new IntPtr(-1));
  using(var handle=new SafeFileHandle(raw,true)){
   IoAclProof(handle,sid,true);
   IoNtfsProof(handle);
   var proof=IoFileProof(handle,r.Path,r,sid,request.ByteLength,r.FileId);
   IoRequire(Same(proof.volumeId,r.VolumeId));
   using(var stream=new FileStream(handle,FileAccess.ReadWrite,4096,false)){
    string sha256=IoStreamHash(stream,request.ByteLength,PersistenceIoCopyMaxBytes);
    IoRequire(CryptographicOperations.FixedTimeEquals(Convert.FromHexString(sha256),Convert.FromHexString(r.ExpectedSha256)));
    directories.Recheck();
    destinationDirectories.Recheck();
    attempted=true; // The rename below is the only mutation; no retry after it.
    if(!IoRenameNoReplace(handle,request.Destination,out int error)){
     directories.Recheck();
     destinationDirectories.Recheck();
     return IoV4FailureOutcome(request,error==80||error==183?"EXISTS":"UNKNOWN");
    }
    stream.Flush(true);
    var file=IoFileProof(handle,request.Destination,DestRequest(r,request),sid,request.ByteLength,proof.fileId);
    IoAclProof(handle,sid,true);
    IoNtfsProof(handle);
    var directory=destinationDirectories.Recheck();
    var sourceDirectory=directories.Recheck();
    return new IoV4Outcome {Status=0,Payload=new byte[0],Response=new {
     contractVersion=4,operation=r.Operation,path=r.Path,root=r.Root,attemptId=r.AttemptId,state="APPLIED",
     destination=request.Destination,
     file=IoEvidence(file,sid),directory=IoEvidence(directory,sid),sourceDirectory=IoEvidence(sourceDirectory,sid),
     byteLength=request.ByteLength,sha256,contentFlushed=true,filesystem="NTFS",
     durability=IoV4Durability()
    }};
   }
  }
 }
 // Delete only the exact expected file on a held DELETE handle via
 // SetFileInformationByHandle(FileDispositionInfo). Never File.Delete or a
 // path-based unlink; an ambiguous outcome is UNKNOWN and retained.
 static IoV4Outcome IoV4UnlinkExact(IoV4Request request,string sid,IoDirectoryLocks directories,ref bool attempted){
  IoRequest r=request.Common;
  IntPtr raw=CreateFileW(r.Path,IoGenericRead|IoDeleteAccess|IoReadControl,IoShareRead,IntPtr.Zero,OpenExisting,FileFlagOpenReparsePoint,IntPtr.Zero);
  IoRequire(raw!=new IntPtr(-1));
  using(var handle=new SafeFileHandle(raw,true)){
   IoAclProof(handle,sid,false);
   IoNtfsProof(handle);
   var proof=IoFileProof(handle,r.Path,r,sid,request.ByteLength,r.FileId);
   IoRequire(Same(proof.volumeId,r.VolumeId));
   using(var stream=new FileStream(handle,FileAccess.Read,4096,false)){
    string sha256=IoStreamHash(stream,request.ByteLength,(int)Math.Min(request.MaxBytes,(long)int.MaxValue));
    IoRequire(CryptographicOperations.FixedTimeEquals(Convert.FromHexString(sha256),Convert.FromHexString(r.ExpectedSha256)));
    var file=IoFileProof(handle,r.Path,r,sid,request.ByteLength,r.FileId);
    var directory=directories.Recheck();
    IntPtr buffer=Marshal.AllocHGlobal(1);
    bool disposed;
    try{
     Marshal.WriteByte(buffer,0,1); // FILE_DISPOSITION_INFO.DeleteFile=TRUE.
     attempted=true;
     disposed=IoSetFileInformation(handle,IoFileDispositionInfo,buffer,1);
    }finally{Marshal.FreeHGlobal(buffer);}
    IoRequire(disposed);
    directories.Recheck();
    return new IoV4Outcome {Status=0,Payload=new byte[0],Response=new {
     contractVersion=4,operation=r.Operation,path=r.Path,root=r.Root,attemptId=r.AttemptId,state="APPLIED",
     file=IoEvidence(file,sid),directory=IoEvidence(directory,sid),
     byteLength=request.ByteLength,sha256,unlinked=true,filesystem="NTFS"
    }};
   }
  }
 }
 // prove-sync is an actual file FlushFileBuffers on the held handle only; it
 // is never presented as directory durability.
 static IoV4Outcome IoV4ProveSync(IoV4Request request,string sid,IoDirectoryLocks directories,ref bool attempted){
  IoRequest r=request.Common;
  IntPtr raw=CreateFileW(r.Path,IoGenericRead|IoGenericWrite|IoReadControl,IoShareRead,IntPtr.Zero,OpenExisting,FileFlagOpenReparsePoint,IntPtr.Zero);
  IoRequire(raw!=new IntPtr(-1));
  using(var handle=new SafeFileHandle(raw,true)){
   IoAclProof(handle,sid,true);
   IoNtfsProof(handle);
   var proof=IoFileProof(handle,r.Path,r,sid,request.ByteLength,r.FileId);
   IoRequire(Same(proof.volumeId,r.VolumeId));
   using(var stream=new FileStream(handle,FileAccess.ReadWrite,4096,false)){
    string sha256=IoStreamHash(stream,request.ByteLength,PersistenceIoCopyMaxBytes);
    IoRequire(CryptographicOperations.FixedTimeEquals(Convert.FromHexString(sha256),Convert.FromHexString(r.ExpectedSha256)));
    directories.Recheck();
    attempted=true;
    stream.Flush(true); // FlushFileBuffers on THIS file's handle.
    var file=IoFileProof(handle,r.Path,r,sid,request.ByteLength,r.FileId);
    var directory=directories.Recheck();
    return new IoV4Outcome {Status=0,Payload=new byte[0],Response=new {
     contractVersion=4,operation=r.Operation,path=r.Path,root=r.Root,attemptId=r.AttemptId,state="APPLIED",
     file=IoEvidence(file,sid),directory=IoEvidence(directory,sid),
     byteLength=request.ByteLength,sha256,contentFlushed=true,filesystem="NTFS",
     durability=IoV4Durability()
    }};
   }
  }
 }
 static int IoV4Output(IoV4Outcome outcome,ref bool outputAttempted){
  IoRequire(IoPipes());
  byte[] header=JsonSerializer.SerializeToUtf8Bytes(outcome.Response,new JsonSerializerOptions {
   Encoder=System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping
  });
  IoRequire(header.Length>0&&header.Length<=PersistenceIoMaxHeaderBytes);
  foreach(byte b in header)IoRequire(b<0x80);
  byte[] payload=outcome.Payload??new byte[0];
  IoRequire(4+header.Length+payload.Length<=PersistenceIoMaxOutputBytes);
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
 static int PrivatePersistenceIoMode(){
  if(!IoPipes()){Console.Error.Write("WINDOWS_PRIVATE_PERSISTENCE_UNSAFE");return 1;}
  IoV4Request request=null;
  bool attempted=false;
  bool outputAttempted=false;
  IoV4Outcome outcome=null;
  try{
   request=IoReadV4Request();
   using(var identity=WindowsIdentity.GetCurrent()){
    string sid=identity.User.Value;
    IoRequest r=request.Common;
    bool twoParents=(r.Operation=="copy-new"||r.Operation=="rename-new"||r.Operation=="rename-directory-new")&&!Same(r.Parent,request.DestinationParent);
    using(var directories=new IoDirectoryLocks(r,sid))
    using(var destinationDirectories=twoParents?new IoDirectoryLocks(DestRequest(r,request),sid):null){
     directories.RecheckExclusive();
     destinationDirectories?.RecheckExclusive();
     if(r.Operation=="inspect-directory")outcome=IoV4InspectDirectory(request,sid,directories);
     else if(r.Operation=="inspect-tree"||r.Operation=="rename-directory-new")outcome=IoV4Tree(request,sid,directories,destinationDirectories??directories,ref attempted);
     else if(r.Operation=="inspect-file-identity")outcome=IoV4InspectIdentity(request,sid,directories);
     else if(r.Operation=="inspect-file")outcome=IoV4InspectFile(request,sid,directories);
     else if(r.Operation=="read")outcome=IoV4Read(request,sid,directories);
     else if(r.Operation=="write-new")outcome=IoV4WriteNew(request,sid,directories,ref attempted);
     else if(r.Operation=="copy-new")outcome=IoV4CopyNew(request,sid,directories,destinationDirectories??directories,ref attempted);
     else if(r.Operation=="rename-new")outcome=IoV4RenameNew(request,sid,directories,destinationDirectories??directories,ref attempted);
     else if(r.Operation=="unlink-exact")outcome=IoV4UnlinkExact(request,sid,directories,ref attempted);
     else outcome=IoV4ProveSync(request,sid,directories,ref attempted);
     directories.RecheckExclusive();
     destinationDirectories?.RecheckExclusive();
    }
   }
  }catch{
   if(request!=null){
    try{outcome=IoV4FailureOutcome(request,attempted?"UNKNOWN":"REJECTED");}catch{outcome=null;}
   }else outcome=null;
  }
  if(outcome==null){Console.Error.Write("WINDOWS_PRIVATE_PERSISTENCE_UNSAFE");return attempted||outputAttempted?3:1;}
  try{return IoV4Output(outcome,ref outputAttempted);}
  catch{Console.Error.Write("WINDOWS_PRIVATE_PERSISTENCE_UNSAFE");return 3;}
 }
}
