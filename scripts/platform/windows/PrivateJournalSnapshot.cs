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
// Hot rollback-journal private snapshot. Operation "snapshot" opens EVERY
// present actual source (main/-journal/-wal/-shm) with GENERIC_READ|
// READ_CONTROL and read-only sharing, proves each file on its own handle,
// creates the first free of four fixed per-parent slots with a protected
// owner DACL, writes an immutable intent.json, immutable raw-source copies
// source.sqlite{suffix} and working copies snapshot.sqlite{suffix} — all
// CREATE_NEW, same-handle flush + readback + hash — rechecks every source
// (including still-absent sidecars) while all handles are held, then writes
// the immutable prepared.json receipt. Operation "revalidate" reacquires all
// source handles after the caller's callback and proves presence, File ID,
// volume, length and SHA-256 against the intent manifest persisted in the
// slot. Handles are therefore reacquired across the callback: the source is
// NOT locked continuously while the caller reopens it. Slots are never
// created-or-opened, never deleted and never recursively cleaned; a missing
// receipt never proves nonapplication. Writes that cannot be completed
// leave partial evidence retained under the occupied slot.
internal static partial class PrivateRootProbeProgram {
 const int JsHotJournalMaxBytes=64*1024*1024;
 const int JsSnapshotSlots=4;
 const int JsMaxReceiptBytes=64*1024;
 const int JsMaxStdinBytes=64*1024;
 const int JsMaxLifecycleStdinBytes=1024*1024;
 const int JsMaxOutputBytes=64*1024;
 const int JsStreamBuffer=64*1024;
 const string JsSlotPrefix=".folio-hot-snapshot-";
 const string JsArchivePrefix=".folio-hot-archive-";
 const string JsCapturePrefix=".folio-hot-capture-";
 const int JsMaxCaptures=64;
 const long JsCaptureReserveBytes=2L*1024*1024;
 const string JsAdmissionLockName=".folio-hot-admission.lock";
 const int JsMaxArchives=16;
 const long JsRetainedBudgetBytes=64L*1024*1024*1024;
 const long JsFreeReserveBytes=256L*1024*1024;
 const long JsLifecycleReserveBytes=2*1024*1024;
 const int JsErrorFileNotFound=2;
 const int JsStatusNameCollision=unchecked((int)0xC0000035);
 const uint JsFileCreate=2;
 const uint JsFileOpenIf=3;
 const int JsFileDispositionInformation=4; // Win32 FILE_INFO_BY_HANDLE_CLASS.FileDispositionInfo
 const int JsFileNonDirectory=0x40;
 static readonly string[] JsSuffixes={"","-journal","-wal","-shm"};
 static readonly string[] JsReceiptNames={"intent.json","prepared.json","revalidated.json","captures.json"};
 static readonly string[] JsSlotFileNames={"intent.json","prepared.json","revalidated.json","revalidation-failed.json","captures.json","release-intent.json","released.json","release-capture.json","source.sqlite","source.sqlite-journal","source.sqlite-wal","source.sqlite-shm","snapshot.sqlite","snapshot.sqlite-journal","snapshot.sqlite-wal","snapshot.sqlite-shm"};
 sealed class JsProfile {
  public string Name;
  public long MainBytes;
  public long SidecarBytes;
  public long CombinedBytes;
 }
 static readonly JsProfile[] JsProfiles={
  new JsProfile{Name="small-ledger",MainBytes=64L*1024*1024,SidecarBytes=64L*1024*1024,CombinedBytes=256L*1024*1024},
  new JsProfile{Name="recovery-archive",MainBytes=1024L*1024*1024,SidecarBytes=1024L*1024*1024,CombinedBytes=2L*1024*1024*1024},
  new JsProfile{Name="backup-artifact",MainBytes=4L*1024*1024*1024,SidecarBytes=8L*1024*1024*1024,CombinedBytes=28L*1024*1024*1024},
 };
 static JsProfile JsProfileFor(string name){
  foreach(var p in JsProfiles)if(p.Name==name)return p;
  IoRequire(false);
  return null;
 }
 [StructLayout(LayoutKind.Sequential)]
 struct JS_UNICODE_STRING { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }
 [StructLayout(LayoutKind.Sequential)]
 struct JS_OBJECT_ATTRIBUTES { public uint Length; public IntPtr RootDirectory; public IntPtr ObjectName; public uint Attributes; public IntPtr SecurityDescriptor; public IntPtr SecurityQualityOfService; }
 [DllImport("ntdll.dll",EntryPoint="NtCreateFile",ExactSpelling=true)]
 static extern int JsNtCreateFile(out SafeFileHandle handle,uint access,ref JS_OBJECT_ATTRIBUTES attributes,out IO_STATUS_BLOCK status,IntPtr allocationSize,uint fileAttributes,uint shareAccess,uint disposition,uint options,IntPtr eaBuffer,uint eaLength);
 sealed class JsRequest {
  public IoRequest Common;
  public int Slot=-1;
  public string SlotFileId="";
  public string SlotVolumeId="";
  public string Profile="small-ledger";
  public string Fingerprint="";
  public string AuthorityFingerprint="";
  public Dictionary<string,JsonElement> Captures;
  public string InspectionState="";
  public bool Archived;
  public JsonElement ReleaseCapture;
  public byte[] Encoded;
  public string CaptureId="";
  public string CapturePhase="";
  public string CaptureFileId="";
  public int CaptureWireLength;
  public string CaptureWireHash="";
  public int CaptureIndex;
  public byte[] CaptureBytes;
  public byte[] CaptureStdout;
  public byte[] CaptureStderr;
  public byte[] CaptureMetadata;
 }
 sealed class JsOutcome {
  public object Response;
  public int Status;
 }
 sealed class JsSource {
  public string Suffix;
  public string Path;
  public SafeFileHandle Handle;
  public FileStream Stream;
  public bool Present;
  public FolioWindowsProbeResult Proof;
  public long Length;
  public string Sha256;
 }
 sealed class JsNamedEntry {
  public string Name="";
  public bool Present;
  public string FileId="";
  public string VolumeId="";
  public long Length;
  public string Sha256="";
 }
 sealed class JsExpectation {
  public string Suffix="";
  public bool Present;
  public string FileId="";
  public string VolumeId="";
  public long Length;
  public string Sha256="";
 }
 static object JsFailureResponse(IoRequest r,string state,string reason,int slot){
  if(slot>=0)
   return new {version=1,operation=r.Operation,path=r.Path,root=r.Root,attemptId=r.AttemptId,slot,state,reason};
  return new {version=1,operation=r.Operation,path=r.Path,root=r.Root,attemptId=r.AttemptId,state,reason};
 }
 static JsOutcome JsFailureOutcome(JsRequest request,string state,string reason){
  IoRequest r=request.Common;
  int status=state=="UNKNOWN"?3:1;
  return new JsOutcome {Status=status,Response=JsFailureResponse(r,state,reason,request.Slot)};
 }
 // Strict request parser with duplicate-key rejection, mirroring the v2/v3
 // readers. Input is bounded at max+1 and parsed only after pipe EOF. The
 // lifecycle operations (seal/inspect/release) use the separate 1MiB
 // lifecycle stdin cap; snapshot/revalidate stay on the 64KiB wire.
 static JsRequest JsReadRequest(){
  using var input=Console.OpenStandardInput();
  using var buffer=new MemoryStream();
  byte[] chunk=new byte[8192];
  for(;;){
   long remaining=(long)JsMaxLifecycleStdinBytes+1-buffer.Length;
   int count=input.Read(chunk,0,(int)Math.Min(chunk.Length,remaining));
   if(count==0)break;
   buffer.Write(chunk,0,count);
   IoRequire(buffer.Length<=JsMaxLifecycleStdinBytes);
  }
  byte[] encoded=buffer.ToArray();
  IoRequire(encoded.Length>0&&!(encoded.Length>=3&&encoded[0]==0xef&&encoded[1]==0xbb&&encoded[2]==0xbf));
  string json=new System.Text.UTF8Encoding(false,true).GetString(encoded);
  using var document=JsonDocument.Parse(json,new JsonDocumentOptions {AllowTrailingCommas=false,CommentHandling=JsonCommentHandling.Disallow,MaxDepth=8});
  JsonElement obj=document.RootElement;
  IoRequire(obj.ValueKind==JsonValueKind.Object);
  var fields=new Dictionary<string,JsonElement>(StringComparer.Ordinal);
  foreach(JsonProperty property in obj.EnumerateObject()){
   IoRequire(!fields.ContainsKey(property.Name));
   fields.Add(property.Name,property.Value);
  }
  IoRequire(fields.ContainsKey("operation"));
  string operation=IoString(fields["operation"]);
  bool capture=operation=="capture-intent"||operation=="capture-wire"||operation=="capture-ready"||operation=="capture-output";
  IoRequire(capture||JsCorePhase(operation));
  if(operation=="snapshot"||operation=="revalidate")IoRequire(encoded.Length<=JsMaxStdinBytes);
  var names=new HashSet<string>(new[]{"version","operation","path","root","rootFileId","rootVolumeId","directoryFileId","directoryVolumeId","fileId","volumeId","attemptId","profile"},StringComparer.Ordinal);
  if(!capture&&operation!="snapshot")names.UnionWith(new[]{"slot","slotFileId","slotVolumeId"});
  if(capture){
   names.UnionWith(new[]{"captureId","capturePhase","wireByteLength","wireSha256"});
   if(operation!="capture-intent")names.Add("captureFileId");
   if(operation=="capture-wire")names.UnionWith(new[]{"index","bytes"});
   if(operation=="capture-output")names.UnionWith(new[]{"stdout","stderr","metadata"});
  }
  if(operation=="seal")names.Add("captures");
  if(operation=="release")names.UnionWith(new[]{"fingerprint","authorityFingerprint","inspectionState"});
  if(operation=="inspect"&&fields.ContainsKey("archived"))names.Add("archived");
  if(operation=="commit-release-evidence")names.Add("capture");
  IoRequire(fields.Count==names.Count||(fields.Count==names.Count-1&&!fields.ContainsKey("profile")));
  foreach(string name in fields.Keys)IoRequire(names.Contains(name));
  IoRequire(IoInteger(fields["version"])==1);
  var r=new IoRequest {
   Operation=operation,Path=IoCanonical(IoString(fields["path"])),Root=IoCanonical(IoString(fields["root"])),
   RootFileId=IoHex(fields["rootFileId"],32),RootVolumeId=IoHex(fields["rootVolumeId"],16),
   DirectoryFileId=IoHex(fields["directoryFileId"],32),DirectoryVolumeId=IoHex(fields["directoryVolumeId"],16)
  };
  RelativeDirectorySegments(r.Path,r.Root); // Strict descendant; no root-as-file.
  r.Parent=IoCanonical(System.IO.Path.GetDirectoryName(r.Path));
  IoRequire(Same(r.DirectoryVolumeId,r.RootVolumeId));
  if(Same(r.Parent,r.Root))IoRequire(Same(r.DirectoryFileId,r.RootFileId));
  r.FileId=IoHex(fields["fileId"],32);
  r.VolumeId=IoHex(fields["volumeId"],16);
  IoRequire(Same(r.VolumeId,r.RootVolumeId));
  r.AttemptId=IoHex(fields["attemptId"],32,true);
  var request=new JsRequest {Common=r,Encoded=encoded};
  // A legacy wire with no profile means the small-ledger limits only; the
  // profile is never inferred from names or sizes.
  if(fields.TryGetValue("profile",out var profileField))request.Profile=IoString(profileField);
  JsProfileFor(request.Profile);
  if(capture){
   request.CaptureId=IoHex(fields["captureId"],32,true);
   request.CapturePhase=IoString(fields["capturePhase"]);
   IoRequire(JsCorePhase(request.CapturePhase)); // No capture-of-capture recursion.
   request.CaptureWireLength=IoInteger(fields["wireByteLength"]);
   int wireLimit=request.CapturePhase=="snapshot"||request.CapturePhase=="revalidate"?JsMaxStdinBytes:JsMaxLifecycleStdinBytes;
   IoRequire(request.CaptureWireLength>0&&request.CaptureWireLength<=wireLimit);
   request.CaptureWireHash=IoHex(fields["wireSha256"],64,true);
   if(operation!="capture-intent")request.CaptureFileId=IoHex(fields["captureFileId"],32);
   if(operation=="capture-wire"){
    request.CaptureIndex=IoInteger(fields["index"]);
    IoRequire(request.CaptureIndex>=0&&request.CaptureIndex<(request.CaptureWireLength+JsMaxStdinBytes-1)/JsMaxStdinBytes);
    request.CaptureBytes=JsRawComponent(fields["bytes"]);
    IoRequire(request.CaptureBytes.Length==Math.Min(JsMaxStdinBytes,request.CaptureWireLength-request.CaptureIndex*JsMaxStdinBytes));
   }
   if(operation=="capture-output"){
    request.CaptureStdout=JsRawComponent(fields["stdout"]);
    request.CaptureStderr=JsRawComponent(fields["stderr"]);
    request.CaptureMetadata=JsRawComponent(fields["metadata"]);
   }
   IoCanonical(IoChild(r.Parent,JsCapturePrefix+request.CaptureId));
   return request;
  }
  if(operation!="snapshot"){
   request.Slot=IoInteger(fields["slot"]);
   IoRequire(request.Slot>=0&&request.Slot<JsSnapshotSlots);
   request.SlotFileId=IoHex(fields["slotFileId"],32);
   request.SlotVolumeId=IoHex(fields["slotVolumeId"],16);
   IoRequire(Same(request.SlotVolumeId,r.RootVolumeId));
   // The slot identity is fixed under the actual source parent, never a
   // caller-supplied directory.
   string slotPath=IoCanonical(IoChild(r.Parent,JsSlotPrefix+request.Slot));
   RelativeDirectorySegments(slotPath,r.Root);
  }
  if(operation=="seal"){
   JsonElement captures=fields["captures"];
   IoRequire(captures.ValueKind==JsonValueKind.Object);
   var parsed=new Dictionary<string,JsonElement>(StringComparer.Ordinal);
   foreach(JsonProperty phase in captures.EnumerateObject()){
    IoRequire(phase.Name=="snapshot"||phase.Name=="revalidate");
    IoRequire(!parsed.ContainsKey(phase.Name));
    IoRequire(phase.Value.ValueKind==JsonValueKind.Object);
    var entry=new Dictionary<string,JsonElement>(StringComparer.Ordinal);
    foreach(JsonProperty field in phase.Value.EnumerateObject()){
     IoRequire(field.Name=="request"||field.Name=="response"||field.Name=="stderr");
     IoRequire(!entry.ContainsKey(field.Name));
     string value=IoString(field.Value);
     IoRequire(value.Length<=2*JsMaxReceiptBytes);
     byte[] decoded=Convert.FromBase64String(value);
     IoRequire(decoded.Length<=JsMaxReceiptBytes&&Convert.ToBase64String(decoded)==value);
     if(field.Name=="stderr")IoRequire(decoded.Length==0);
     entry[field.Name]=JsonDocument.Parse(JsonSerializer.Serialize(new{value,byteLength=decoded.Length,sha256=IoSha256(decoded)})).RootElement.Clone();
    }
    IoRequire(entry.ContainsKey("request")&&entry.ContainsKey("response")&&entry.ContainsKey("stderr")&&entry.Count==3);
    parsed[phase.Name]=JsonDocument.Parse(JsonSerializer.Serialize(entry)).RootElement.Clone();
   }
   IoRequire(parsed.ContainsKey("snapshot")&&parsed.ContainsKey("revalidate")&&parsed.Count==2);
   request.Captures=parsed;
  }
  if(operation=="release"){
   request.Fingerprint=IoHex(fields["fingerprint"],64,true);
   request.AuthorityFingerprint=IoString(fields["authorityFingerprint"]);
   IoRequire(request.AuthorityFingerprint.Length>0&&request.AuthorityFingerprint.Length<=256);
   request.InspectionState=IoString(fields["inspectionState"]);
   IoRequire(request.InspectionState=="REVALIDATED");
  }
  if(operation=="inspect"&&fields.TryGetValue("archived",out var archived)){
   IoRequire(archived.ValueKind==JsonValueKind.True||archived.ValueKind==JsonValueKind.False);
   request.Archived=archived.GetBoolean();
  }
  if(operation=="commit-release-evidence")request.ReleaseCapture=fields["capture"].Clone();
  // Prove every derived name before any directory or file creation.
  foreach(string suffix in JsSuffixes)IoCanonical(r.Path+suffix);
  for(int index=0;index<JsSnapshotSlots;index++){
   string slotPath=IoCanonical(IoChild(r.Parent,JsSlotPrefix+index));
   foreach(string name in new[]{"intent.json","prepared.json","revalidated.json","revalidation-failed.json"})
    IoCanonical(IoChild(slotPath,name));
   foreach(string suffix in JsSuffixes){
    IoCanonical(IoChild(slotPath,"source.sqlite"+suffix));
    IoCanonical(IoChild(slotPath,"snapshot.sqlite"+suffix));
   }
  }
  return request;
 }
 // Streaming SHA-256 over an already-proven same-handle stream: fixed 64KiB
 // buffer, IncrementalHash, exact EOF/length checks and no int payload casts.
 static string JsStreamHash(FileStream stream,long length){
  IoRequire(length>=0);
  stream.Position=0;
  byte[] buffer=new byte[JsStreamBuffer];
  using(var hash=System.Security.Cryptography.IncrementalHash.CreateHash(System.Security.Cryptography.HashAlgorithmName.SHA256)){
   long remaining=length;
   while(remaining>0){
    int count=stream.Read(buffer,0,(int)Math.Min(buffer.Length,remaining));
    IoRequire(count>0);
    hash.AppendData(buffer,0,count);
    remaining-=count;
   }
   IoRequire(stream.ReadByte()==-1&&stream.Length==length);
   return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
  }
 }
 // Single source open: read-only access, read-only sharing, no reparse
 // following, proof on the same handle BEFORE bytes are trusted. Only Win32
 // FILE_NOT_FOUND(2) may mean absent, and only for sidecars; the main file is
 // mandatory and every other error rejects. Source writes are never requested.
 // Hashing streams through the held handle; no source byte[] materialization.
 static JsSource JsOpenSource(IoRequest r,string sid,string suffix,bool required,JsProfile profile){
  string source=r.Path+suffix;
  var entry=new JsSource {Suffix=suffix,Path=source};
  IntPtr raw=CreateFileW(source,IoGenericRead|IoReadControl,IoShareRead,IntPtr.Zero,OpenExisting,FileFlagOpenReparsePoint,IntPtr.Zero);
  if(raw==new IntPtr(-1)){
   int error=Marshal.GetLastWin32Error();
   IoRequire(error==JsErrorFileNotFound&&!required);
   return entry;
  }
  entry.Present=true;
  entry.Handle=new SafeFileHandle(raw,true);
  try{
   entry.Stream=new FileStream(entry.Handle,FileAccess.Read,JsStreamBuffer,false);
   var standard=IoInspect(entry.Handle,false);
   long roleLimit=suffix.Length==0?profile.MainBytes:profile.SidecarBytes;
   IoRequire(standard.EndOfFile>=0&&standard.EndOfFile<=roleLimit);
   entry.Length=standard.EndOfFile;
   // required means presence, not main-file identity: a present sidecar has
   // its own ID, compared to its manifest entry during revalidation.
   entry.Proof=IoFileProof(entry.Handle,source,r,sid,entry.Length,suffix.Length==0?r.FileId:null);
   IoAclProof(entry.Handle,sid,false);
   IoNtfsProof(entry.Handle);
   entry.Sha256=JsStreamHash(entry.Stream,entry.Length);
   if(suffix=="-journal")JsCheckJournalTail(entry.Stream,entry.Length);
   return entry;
  }catch{
   try{entry.Stream?.Dispose();}finally{entry.Handle.Dispose();}
   throw;
  }
 }
 // SQLite may follow a super-journal pathname embedded in a rollback trailer.
 // This bounded profile does not copy attached databases or grant authority
 // over that pathname. Only the 8-byte journal tail is materialized; the
 // stream position is restored for subsequent streaming passes.
 static void JsCheckJournalTail(FileStream stream,long length){
  byte[] magic={0xd9,0xd5,0x05,0xf9,0x20,0xa1,0x63,0xd7};
  if(length<16)return;
  stream.Position=length-8;
  byte[] tail=new byte[8];
  int read=0;
  while(read<8){int count=stream.Read(tail,read,8-read);IoRequire(count>0);read+=count;}
  bool trailer=true;
  for(int index=0;index<magic.Length;index++)
   if(tail[index]!=magic[index])trailer=false;
  IoRequire(!trailer);
 }
 static void JsDisposeSources(List<JsSource> sources){
  var failures=new List<Exception>();
  foreach(var s in sources){
   try{s.Stream?.Dispose();}catch(Exception e){failures.Add(e);}
   try{s.Handle?.Dispose();}catch(Exception e){failures.Add(e);}
  }
  if(failures.Count>0)throw new AggregateException(failures);
 }
 // Same-handle recheck while everything is still held: identity, length and
 // streaming hash of present sources, and FILE_NOT_FOUND-still for absent
 // sidecars. No source byte[] is materialized at any size.
 static void JsRecheckSources(IoRequest r,string sid,List<JsSource> sources){
  foreach(var s in sources){
   if(!s.Present){
    IntPtr raw=CreateFileW(s.Path,IoGenericRead|IoReadControl,IoShareRead,IntPtr.Zero,OpenExisting,FileFlagOpenReparsePoint,IntPtr.Zero);
    int error=Marshal.GetLastWin32Error();
    if(raw!=new IntPtr(-1)){using(var unexpected=new SafeFileHandle(raw,true)){} IoRequire(false);}
    IoRequire(error==JsErrorFileNotFound);
    continue;
   }
   var proof=IoFileProof(s.Handle,s.Path,r,sid,s.Length,s.Proof.fileId);
   IoRequire(Same(proof.volumeId,s.Proof.volumeId));
   IoAclProof(s.Handle,sid,false);
   IoNtfsProof(s.Handle);
   IoRequire(Same(JsStreamHash(s.Stream,s.Length),s.Sha256));
  }
 }
 // Streaming copy from a held, proven source stream into an exclusively
 // created destination: CREATE_NEW only, protected owner DACL, fixed 64KiB
 // buffer, flush(true), then same-handle length+SHA-256 verification.
 // Never an overwrite. Sources are never opened for write.
 static FolioWindowsProbeResult JsCopyStreaming(FileStream source,long length,string sha256,string dest,IoRequest r,string sid){
  IoCanonical(dest);
  IoRequire(length>=0&&length<=JsProfiles[2].CombinedBytes);
  IntPtr descriptor=IntPtr.Zero;
  SafeFileHandle file;
  try{
   string sddl="O:"+sid+"G:"+sid+"D:P(A;;FA;;;"+sid+")";
   IoRequire(IoConvertSecurityDescriptor(sddl,1,out descriptor,out _));
   var attributes=new IO_SECURITY_ATTRIBUTES {Length=(uint)Marshal.SizeOf<IO_SECURITY_ATTRIBUTES>(),SecurityDescriptor=descriptor,InheritHandle=false};
   file=IoCreateFile(dest,IoGenericRead|IoGenericWrite|IoReadControl,IoShareRead,ref attributes,IoCreateNew,FileFlagOpenReparsePoint|IoWriteThrough,IntPtr.Zero);
   IoRequire(!file.IsInvalid);
  }finally{if(descriptor!=IntPtr.Zero)IoLocalFree(descriptor);}
  using(file){
   var first=IoFileProof(file,dest,r,sid,0,null);
   IoAclProof(file,sid,true);
   IoNtfsProof(file);
   using(var stream=new FileStream(file,FileAccess.ReadWrite,JsStreamBuffer,false)){
    source.Position=0;
    byte[] buffer=new byte[JsStreamBuffer];
    long remaining=length;
    while(remaining>0){
     int count=source.Read(buffer,0,(int)Math.Min(buffer.Length,remaining));
     IoRequire(count>0);
     stream.Write(buffer,0,count);
     remaining-=count;
    }
    IoRequire(source.ReadByte()==-1); // Source stayed exactly `length` bytes.
    stream.Flush(true);
    IoRequire(Same(JsStreamHash(stream,length),sha256));
    var proof=IoFileProof(file,dest,r,sid,length,first.fileId);
    IoAclProof(file,sid,true);
    IoNtfsProof(file);
    stream.Flush(true);
    return proof;
   }
  }
 }
 // Streaming hash+proof of a private slot file on a held handle. Expected
 // length of -1 accepts any bounded length discovered by inspection; used
 // for retained raw copies and lifecycle files that exceed receipt limits.
 static JsNamedEntry JsHashPrivate(string name,string path,IoRequest r,string sid,long expectedLength){
  var entry=new JsNamedEntry {Name=name};
  IntPtr raw=CreateFileW(path,IoGenericRead|IoReadControl,IoShareRead,IntPtr.Zero,OpenExisting,FileFlagOpenReparsePoint,IntPtr.Zero);
  IoRequire(raw!=new IntPtr(-1));
  using(var handle=new SafeFileHandle(raw,true)){
   var standard=IoInspect(handle,false);
   IoRequire(standard.EndOfFile>=0&&standard.EndOfFile<=JsProfiles[2].CombinedBytes);
   if(expectedLength>=0)IoRequire(standard.EndOfFile==expectedLength);
   var proof=IoFileProof(handle,path,r,sid,standard.EndOfFile,null);
   IoAclProof(handle,sid,true);
   IoNtfsProof(handle);
   entry.Present=true;
   entry.FileId=proof.fileId;
   entry.VolumeId=proof.volumeId;
   entry.Length=standard.EndOfFile;
   using(var stream=new FileStream(handle,FileAccess.Read,JsStreamBuffer,false))
    entry.Sha256=JsStreamHash(stream,standard.EndOfFile);
   return entry;
  }
 }
 // CREATE_NEW only, protected owner DACL, same-handle write + flush +
 // readback + hash, and a re-proved identity afterwards. Never an overwrite.
 static FolioWindowsProbeResult JsWriteNewFile(string path,byte[] bytes,IoRequest r,string sid){
  IoCanonical(path);
  IoRequire(bytes.Length<=JsHotJournalMaxBytes);
  IntPtr descriptor=IntPtr.Zero;
  SafeFileHandle file;
  try{
   string sddl="O:"+sid+"G:"+sid+"D:P(A;;FA;;;"+sid+")";
   IoRequire(IoConvertSecurityDescriptor(sddl,1,out descriptor,out _));
   var attributes=new IO_SECURITY_ATTRIBUTES {Length=(uint)Marshal.SizeOf<IO_SECURITY_ATTRIBUTES>(),SecurityDescriptor=descriptor,InheritHandle=false};
   file=IoCreateFile(path,IoGenericRead|IoGenericWrite|IoReadControl,IoShareRead,ref attributes,IoCreateNew,FileFlagOpenReparsePoint|IoWriteThrough,IntPtr.Zero);
   IoRequire(!file.IsInvalid);
  }finally{if(descriptor!=IntPtr.Zero)IoLocalFree(descriptor);}
  using(file){
   var first=IoFileProof(file,path,r,sid,0,null);
   IoAclProof(file,sid,true);
   IoNtfsProof(file);
   using(var stream=new FileStream(file,FileAccess.ReadWrite,4096,false)){
    stream.Write(bytes,0,bytes.Length);
    stream.Flush(true);
    byte[] readback=IoReadExact(stream,bytes.Length,JsHotJournalMaxBytes);
    IoRequire(System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(readback,bytes));
    var proof=IoFileProof(file,path,r,sid,bytes.Length,first.fileId);
    IoAclProof(file,sid,true);
    IoNtfsProof(file);
    stream.Flush(true);
    return proof;
   }
  }
 }
 // The fixed slot directory itself: exclusive protected creation only.
 static FolioWindowsProbeResult JsProveSlot(SafeFileHandle handle,string slotPath,IoRequest r,string sid,string expectedId=null){
   IoInspect(handle,true);
   var proof=IoProof(handle,slotPath,r,sid);
   if(expectedId!=null)IoRequire(Same(proof.fileId,expectedId));
   IoAclProof(handle,sid,true);
   IoNtfsProof(handle);
   return proof;
 }
 static SafeFileHandle JsOpenSlot(string slotPath,IoRequest r,string sid,string expectedId,out FolioWindowsProbeResult proof){
  IntPtr raw=CreateFileW(slotPath,FileReadAttributes|IoReadControl,IoShareRead,IntPtr.Zero,OpenExisting,FileFlagBackupSemantics|FileFlagOpenReparsePoint,IntPtr.Zero);
  IoRequire(raw!=new IntPtr(-1));
  var handle=new SafeFileHandle(raw,true);
  try{proof=JsProveSlot(handle,slotPath,r,sid,expectedId);return handle;}
  catch{handle.Dispose();throw;}
 }
 // FILE_CREATE returns the newly created directory's handle atomically. A
 // CreateDirectoryW followed by a path open cannot prove that the opened
 // directory is the one just created. RootDirectory is the held source parent.
 static SafeFileHandle JsCreateSlot(SafeFileHandle parent,string basename,string sid,ref bool attempted){
  byte[] nameBytes=System.Text.Encoding.Unicode.GetBytes(basename);
  IntPtr descriptor=IntPtr.Zero,nameBuffer=IntPtr.Zero,nameObject=IntPtr.Zero;
  SafeFileHandle created=null;
  bool previousAttempted=attempted;
  try{
   string sddl="O:"+sid+"G:"+sid+"D:P(A;OICI;FA;;;"+sid+")";
   IoRequire(IoConvertSecurityDescriptor(sddl,1,out descriptor,out _));
   nameBuffer=Marshal.AllocHGlobal(nameBytes.Length);
   Marshal.Copy(nameBytes,0,nameBuffer,nameBytes.Length);
   var name=new JS_UNICODE_STRING{Length=checked((ushort)nameBytes.Length),MaximumLength=checked((ushort)nameBytes.Length),Buffer=nameBuffer};
   nameObject=Marshal.AllocHGlobal(Marshal.SizeOf<JS_UNICODE_STRING>());
   Marshal.StructureToPtr(name,nameObject,false);
   var attributes=new JS_OBJECT_ATTRIBUTES{
    Length=(uint)Marshal.SizeOf<JS_OBJECT_ATTRIBUTES>(),RootDirectory=parent.DangerousGetHandle(),
    ObjectName=nameObject,Attributes=0x40,SecurityDescriptor=descriptor,SecurityQualityOfService=IntPtr.Zero
   };
   attempted=true;
   // SYNCHRONIZE; FILE_ATTRIBUTE_DIRECTORY; FILE_DIRECTORY_FILE |
   // FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT. Share READ only.
   int status=JsNtCreateFile(out created,FileReadAttributes|IoReadControl|0x00100000,ref attributes,out IO_STATUS_BLOCK block,IntPtr.Zero,0x10,IoShareRead,JsFileCreate,0x1|0x20|0x00200000,IntPtr.Zero,0);
   if(status==JsStatusNameCollision&&(created==null||created.IsInvalid)){
    created?.Dispose();attempted=previousAttempted;return null;
   }
   IoRequire(status==0&&block.Status==IntPtr.Zero&&block.Information.ToUInt64()==2&&created!=null&&!created.IsInvalid);
   return created;
  }catch{created?.Dispose();throw;}
  finally{
   if(descriptor!=IntPtr.Zero)IoLocalFree(descriptor);
   if(nameBuffer!=IntPtr.Zero)Marshal.FreeHGlobal(nameBuffer);
   if(nameObject!=IntPtr.Zero)Marshal.FreeHGlobal(nameObject);
  }
 }
 // Explicit local-NTFS and owner-ACL proof on a directory the locks only
 // probe (the locks prove IoProof but not the device/ACL flags).
 static void JsProveDirectory(SafeFileHandle handle,string path,IoRequest r,string sid){
   IoInspect(handle,true);
   IoProof(handle,path,r,sid);
   IoAclProof(handle,sid,false);
   IoNtfsProof(handle);
 }
 // Stored manifest entries carry the identity/length/hash evidence used by
 // revalidate comparisons; reply manifests instead carry the full probe
 // evidence object for the caller's strict schema.
 static List<object> JsStoredManifest(List<JsSource> sources){
  var entries=new List<object>();
  foreach(var s in sources)
   entries.Add(s.Present
    ?(object)new {suffix=s.Suffix,present=true,fileId=s.Proof.fileId,volumeId=s.Proof.volumeId,byteLength=s.Length,sha256=s.Sha256}
    :new {suffix=s.Suffix,present=false});
  return entries;
 }
 static List<object> JsReplyManifest(List<JsSource> sources,string sid){
  var entries=new List<object>();
  foreach(var s in sources)
   entries.Add(s.Present
    ?(object)new {suffix=s.Suffix,present=true,byteLength=s.Length,sha256=s.Sha256,evidence=IoEvidence(s.Proof,sid)}
    :new {suffix=s.Suffix,present=false});
  return entries;
 }
 static object JsSavedManifest(JsRequest request,int slot,FolioWindowsProbeResult slotProof,List<JsSource> sources,string state,string operation="snapshot"){
  IoRequest r=request.Common;
  return new {version=1,operation,state,path=r.Path,root=r.Root,profile=request.Profile,
   rootFileId=r.RootFileId,rootVolumeId=r.RootVolumeId,
   directoryFileId=r.DirectoryFileId,directoryVolumeId=r.DirectoryVolumeId,
   fileId=r.FileId,volumeId=r.VolumeId,attemptId=r.AttemptId,slot,
   slotFileId=slotProof.fileId,slotVolumeId=slotProof.volumeId,sources=JsStoredManifest(sources)};
 }
 static JsOutcome JsSnapshot(JsRequest request,string sid,IoDirectoryLocks directories,ref bool attempted){
  IoRequest r=request.Common;
  JsProfile profile=JsProfileFor(request.Profile);
  var sources=new List<JsSource>();
  SafeFileHandle slotHandle=null;
  JsAdmission admission=null;
  try{
   directories.RecheckExclusive();
   // Every present actual source is opened and proven BEFORE the slot create.
   foreach(string suffix in JsSuffixes)
    sources.Add(JsOpenSource(r,sid,suffix,suffix.Length==0,profile));
   long combined=0;
   foreach(var s in sources)if(s.Present)combined+=s.Length;
   IoRequire(combined<=profile.CombinedBytes);
   JsProveDirectory(directories.ParentHandle,r.Parent,r,sid);
   JsProveDirectory(directories.RootHandle,r.Root,r,sid);
   // Serialized admission under the exclusive parent lock: bounded
   // .folio-hot-* inventory, 16 archives max, 64GiB retained budget and a
   // 256MiB free-space reserve after reserving 2x source bytes + metadata.
   admission=JsAcquireAdmission(directories.ParentHandle,r.Parent,r,sid,ref attempted);
   long reserve=2*profile.CombinedBytes+JsLifecycleReserveBytes;
   IoRequire(admission.Retained+reserve<=JsRetainedBudgetBytes);
   IoRequire(admission.FreeSpace>=(ulong)(Math.Max(0,admission.Retained-admission.Actual)+reserve+JsFreeReserveBytes));
   // Capacity is exactly the four fixed slots under the actual parent.
   // An existing slot is never inspected, opened or deleted: advance. Any
   // other creation error is UNKNOWN because the slot may still exist.
   string slotPath=null;
   int slotIndex=-1;
   for(int index=0;index<JsSnapshotSlots;index++){
    string candidate=IoChild(r.Parent,JsSlotPrefix+index);
    request.Slot=index;
    slotHandle=JsCreateSlot(directories.ParentHandle,JsSlotPrefix+index,sid,ref attempted);
    if(slotHandle!=null){slotIndex=index;slotPath=candidate;break;}
   }
   if(slotPath==null)return new JsOutcome {Status=1,Response=JsFailureResponse(r,"REJECTED","PRIVATE_JOURNAL_SNAPSHOT_CAPACITY",-1)};
   var slotProof=JsProveSlot(slotHandle,slotPath,r,sid);
   // Immutable intent first: the manifest the later revalidate trusts.
   var intent=JsSavedManifest(request,slotIndex,slotProof,sources,"INTENT");
   JsWriteNewFile(IoChild(slotPath,"intent.json"),JsonSerializer.SerializeToUtf8Bytes(intent),r,sid);
   foreach(var s in sources){
    if(!s.Present)continue;
    JsCopyStreaming(s.Stream,s.Length,s.Sha256,IoChild(slotPath,"source.sqlite"+s.Suffix),r,sid);
    JsCopyStreaming(s.Stream,s.Length,s.Sha256,IoChild(slotPath,"snapshot.sqlite"+s.Suffix),r,sid);
   }
   // Recheck everything while all source handles remain open, then persist
   // the immutable prepared receipt. Partial evidence stays on failure.
   JsRecheckSources(r,sid,sources);
   directories.RecheckExclusive();
   var prepared=JsSavedManifest(request,slotIndex,slotProof,sources,"PREPARED");
   JsWriteNewFile(IoChild(slotPath,"prepared.json"),JsonSerializer.SerializeToUtf8Bytes(prepared),r,sid);
   var directoryProof=directories.RecheckExclusive();
   JsProveSlot(slotHandle,slotPath,r,sid,slotProof.fileId);
   return new JsOutcome {Status=0,Response=new {
    version=1,operation="snapshot",state="SNAPSHOT",path=r.Path,root=r.Root,profile=request.Profile,attemptId=r.AttemptId,slot=slotIndex,
    snapshotDirectory=slotPath,snapshotPath=IoChild(slotPath,"snapshot.sqlite"),
    sources=JsReplyManifest(sources,sid),directory=IoEvidence(directoryProof,sid),slotDirectory=IoEvidence(slotProof,sid)
   }};
  }finally{
   try{admission?.Dispose();}finally{try{slotHandle?.Dispose();}finally{JsDisposeSources(sources);}}
  }
 }
 // Strict intent.json parse against the same duplicate-key rules; every
 // identity field and the attempt/slot/profile linkage must equal the
 // request. Entries are bounded by the request profile's sidecar limit.
 static List<JsExpectation> JsParseIntent(byte[] bytes,JsRequest request,int slot,FolioWindowsProbeResult slotProof,string operation,string state){
  IoRequest r=request.Common;
  JsProfile profile=JsProfileFor(request.Profile);
  IoRequire(bytes.Length>0&&bytes.Length<=JsMaxReceiptBytes);
  string json=new System.Text.UTF8Encoding(false,true).GetString(bytes);
  using var document=JsonDocument.Parse(json,new JsonDocumentOptions {AllowTrailingCommas=false,CommentHandling=JsonCommentHandling.Disallow,MaxDepth=8});
  JsonElement obj=document.RootElement;
  IoRequire(obj.ValueKind==JsonValueKind.Object);
  var fields=new Dictionary<string,JsonElement>(StringComparer.Ordinal);
  foreach(JsonProperty property in obj.EnumerateObject()){
   IoRequire(!fields.ContainsKey(property.Name));
   fields.Add(property.Name,property.Value);
  }
  var names=new HashSet<string>(new[]{"version","operation","state","path","root","profile","rootFileId","rootVolumeId","directoryFileId","directoryVolumeId","fileId","volumeId","attemptId","slot","slotFileId","slotVolumeId","sources"},StringComparer.Ordinal);
  IoRequire(fields.Count==names.Count);
  foreach(string name in fields.Keys)IoRequire(names.Contains(name));
  IoRequire(IoInteger(fields["version"])==1);
  IoRequire(IoString(fields["operation"])==operation&&IoString(fields["state"])==state);
  IoRequire(IoString(fields["path"])==r.Path&&IoString(fields["root"])==r.Root);
  IoRequire(IoString(fields["profile"])==request.Profile);
  IoRequire(IoHex(fields["rootFileId"],32)==r.RootFileId&&IoHex(fields["rootVolumeId"],16)==r.RootVolumeId);
  IoRequire(IoHex(fields["directoryFileId"],32)==r.DirectoryFileId&&IoHex(fields["directoryVolumeId"],16)==r.DirectoryVolumeId);
  IoRequire(IoHex(fields["fileId"],32)==r.FileId&&IoHex(fields["volumeId"],16)==r.VolumeId);
  IoRequire(IoHex(fields["attemptId"],32,true)==r.AttemptId&&IoInteger(fields["slot"])==slot);
  IoRequire(Same(IoHex(fields["slotFileId"],32),slotProof.fileId)&&Same(IoHex(fields["slotVolumeId"],16),slotProof.volumeId));
  var list=new List<JsExpectation>();
  JsonElement items=fields["sources"];
  IoRequire(items.ValueKind==JsonValueKind.Array);
  int index=0;
  foreach(JsonElement item in items.EnumerateArray()){
   IoRequire(index<JsSuffixes.Length&&item.ValueKind==JsonValueKind.Object);
   var entry=new Dictionary<string,JsonElement>(StringComparer.Ordinal);
   foreach(JsonProperty property in item.EnumerateObject()){
    IoRequire(!entry.ContainsKey(property.Name));
    entry.Add(property.Name,property.Value);
   }
   string suffix=JsSuffixes[index];
   var expectation=new JsExpectation {Suffix=suffix};
   IoRequire(entry.ContainsKey("suffix")&&entry.ContainsKey("present"));
   IoRequire(IoString(entry["suffix"])==suffix);
   IoRequire(entry["present"].ValueKind==JsonValueKind.True||entry["present"].ValueKind==JsonValueKind.False);
   expectation.Present=entry["present"].ValueKind==JsonValueKind.True;
   if(expectation.Present){
    var present=new HashSet<string>(new[]{"suffix","present","fileId","volumeId","byteLength","sha256"},StringComparer.Ordinal);
    IoRequire(entry.Count==present.Count);
    foreach(string name in entry.Keys)IoRequire(present.Contains(name));
    expectation.FileId=IoHex(entry["fileId"],32);
    expectation.VolumeId=IoHex(entry["volumeId"],16);
    IoRequire(Same(expectation.VolumeId,r.RootVolumeId));
    IoRequire(entry["byteLength"].ValueKind==JsonValueKind.Number);
    expectation.Length=entry["byteLength"].GetInt64();
    IoRequire(expectation.Length>=0&&expectation.Length<=(index==0?profile.MainBytes:profile.SidecarBytes));
    IoRequire(index!=0||Same(expectation.FileId,r.FileId));
    expectation.Sha256=IoHex(entry["sha256"],64,true);
   }else{
    IoRequire(entry.Count==2);
   }
   list.Add(expectation);
   index++;
  }
  IoRequire(index==JsSuffixes.Length&&list[0].Present); // Main is mandatory.
  long combined=0;
  foreach(var e in list)if(e.Present)combined+=e.Length;
  IoRequire(combined<=profile.CombinedBytes);
  return list;
 }
 static byte[] JsReadPrivate(string path,IoRequest r,string sid,int maximum){
  IntPtr raw=CreateFileW(path,IoGenericRead|IoReadControl,IoShareRead,IntPtr.Zero,OpenExisting,FileFlagOpenReparsePoint,IntPtr.Zero);
  IoRequire(raw!=new IntPtr(-1));
  using(var handle=new SafeFileHandle(raw,true)){
   var standard=IoInspect(handle,false);
   IoRequire(standard.EndOfFile>=0&&standard.EndOfFile<=maximum);
   int length=checked((int)standard.EndOfFile);
   IoFileProof(handle,path,r,sid,length,null);
   IoAclProof(handle,sid,true);
   IoNtfsProof(handle);
   using(var stream=new FileStream(handle,FileAccess.Read,4096,false))
    return IoReadExact(stream,length,maximum);
  }
 }
 static JsOutcome JsRevalidate(JsRequest request,string sid,IoDirectoryLocks directories,ref bool attempted){
  IoRequest r=request.Common;
  attempted=true; // The slot exists once the request parsed; no retry.
  JsProfile profile=JsProfileFor(request.Profile);
  string slotPath=IoChild(r.Parent,JsSlotPrefix+request.Slot);
  SafeFileHandle slotHandle=null;
  FolioWindowsProbeResult slotProof=null;
  bool intentBound=false;
  using var admission=JsAcquireAdmission(directories.ParentHandle,r.Parent,r,sid,ref attempted);
  try{
   directories.RecheckExclusive();
   slotHandle=JsOpenSlot(slotPath,r,sid,request.SlotFileId,out slotProof);
   IoRequire(Same(slotProof.volumeId,request.SlotVolumeId));
   JsProveDirectory(directories.ParentHandle,r.Parent,r,sid);
   JsProveDirectory(directories.RootHandle,r.Root,r,sid);
   // The saved manifest — not a caller-supplied directory — ties this
   // revalidation to the original source and attempt.
   var expectations=JsParseIntent(JsReadPrivate(IoChild(slotPath,"intent.json"),r,sid,JsMaxReceiptBytes),request,request.Slot,slotProof,"snapshot","INTENT");
   intentBound=true;
   var prepared=JsParseIntent(JsReadPrivate(IoChild(slotPath,"prepared.json"),r,sid,JsMaxReceiptBytes),request,request.Slot,slotProof,"snapshot","PREPARED");
   var sources=new List<JsSource>();
   try{
    for(int index=0;index<JsSuffixes.Length;index++){
     var expected=expectations[index];
     var saved=prepared[index];
     IoRequire(saved.Present==expected.Present&&Same(saved.FileId,expected.FileId)&&Same(saved.VolumeId,expected.VolumeId)&&saved.Length==expected.Length&&saved.Sha256==expected.Sha256);
     var s=JsOpenSource(r,sid,JsSuffixes[index],expected.Present,profile);
     sources.Add(s); // Own the handle before any comparison can throw.
     IoRequire(s.Present==expected.Present);
     if(s.Present){
      IoRequire(Same(s.Proof.fileId,expected.FileId)&&Same(s.Proof.volumeId,expected.VolumeId));
      IoRequire(s.Length==expected.Length&&s.Sha256==expected.Sha256);
      var retained=JsHashPrivate("source.sqlite"+s.Suffix,IoChild(slotPath,"source.sqlite"+s.Suffix),r,sid,expected.Length);
      IoRequire(retained.Sha256==expected.Sha256);
     }
    }
    JsRecheckSources(r,sid,sources);
    var directoryProof=directories.RecheckExclusive();
    JsProveSlot(slotHandle,slotPath,r,sid,request.SlotFileId);
    var receipt=JsSavedManifest(request,request.Slot,slotProof,sources,"REVALIDATED","revalidate");
    JsWriteNewFile(IoChild(slotPath,"revalidated.json"),JsonSerializer.SerializeToUtf8Bytes(receipt),r,sid);
    return new JsOutcome {Status=0,Response=new {
     version=1,operation="revalidate",state="REVALIDATED",path=r.Path,root=r.Root,profile=request.Profile,attemptId=r.AttemptId,slot=request.Slot,
     sources=JsReplyManifest(sources,sid),directory=IoEvidence(directoryProof,sid),slotDirectory=IoEvidence(slotProof,sid)
    }};
   }finally{
    JsDisposeSources(sources);
   }
  }catch{
   // Retain the failed evidence next to the immutable intent when feasible;
   // CREATE_NEW only, never an overwrite or a second attempt.
   try{
    IoRequire(intentBound&&slotHandle!=null&&slotProof!=null);
    JsProveSlot(slotHandle,slotPath,r,sid,request.SlotFileId);
    var failed=new {version=1,operation="revalidate",state="FAILED",path=r.Path,root=r.Root,attemptId=r.AttemptId,slot=request.Slot};
    JsWriteNewFile(IoChild(slotPath,"revalidation-failed.json"),JsonSerializer.SerializeToUtf8Bytes(failed),r,sid);
   }catch{}
   throw;
  }finally{slotHandle?.Dispose();}
 }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,EntryPoint="GetDiskFreeSpaceExW",SetLastError=true)]
 static extern bool JsGetDiskFreeSpaceExW(string path,out ulong freeAvailable,out ulong total,out ulong totalFree);
 // Serialized admission: one exclusive, no-share handle on the fixed
 // protected lock file under the held source parent. It is never evidence
 // or authority and is never removed; there is no PID or stale-lock
 // takeover. Held while the .folio-hot-* inventory and free-space checks run.
 sealed class JsAdmission:IDisposable {
  public SafeFileHandle Lock;
  public long Retained;
  public long Actual;
  public int Archives;
  public int Captures;
  public ulong FreeSpace;
  public void Dispose(){Lock?.Dispose();}
 }
 static JsAdmission JsAcquireAdmission(SafeFileHandle parentHandle,string parentPath,IoRequest r,string sid,ref bool attempted,bool inventory=true){
  byte[] nameBytes=System.Text.Encoding.Unicode.GetBytes(JsAdmissionLockName);
  IntPtr descriptor=IntPtr.Zero,nameBuffer=IntPtr.Zero,nameObject=IntPtr.Zero;
  SafeFileHandle lockHandle=null;
  try{
   string sddl="O:"+sid+"G:"+sid+"D:P(A;;FA;;;"+sid+")";
   IoRequire(IoConvertSecurityDescriptor(sddl,1,out descriptor,out _));
   nameBuffer=Marshal.AllocHGlobal(nameBytes.Length);
   Marshal.Copy(nameBytes,0,nameBuffer,nameBytes.Length);
   var name=new JS_UNICODE_STRING{Length=checked((ushort)nameBytes.Length),MaximumLength=checked((ushort)nameBytes.Length),Buffer=nameBuffer};
   nameObject=Marshal.AllocHGlobal(Marshal.SizeOf<JS_UNICODE_STRING>());
   Marshal.StructureToPtr(name,nameObject,false);
   var attributes=new JS_OBJECT_ATTRIBUTES{
    Length=(uint)Marshal.SizeOf<JS_OBJECT_ATTRIBUTES>(),RootDirectory=parentHandle.DangerousGetHandle(),
    ObjectName=nameObject,Attributes=0x40,SecurityDescriptor=descriptor,SecurityQualityOfService=IntPtr.Zero
   };
   // FILE_OPEN_IF, no sharing: a single synchronous serializer. A
   // preexisting lock still opens; owner/ACL/identity proofs below reject
   // a foreign file. The lock file itself carries no lifecycle meaning.
   // Generic read|write access: metadata-only rights cannot exclude other
   // openers effectively.
   int status=JsNtCreateFile(out lockHandle,IoGenericRead|IoGenericWrite|IoReadControl|IoSynchronize,ref attributes,out IO_STATUS_BLOCK block,IntPtr.Zero,0,0,JsFileOpenIf,JsFileNonDirectory|IoFileSynchronousIoNonAlert|IoFileOpenReparsePoint,IntPtr.Zero,0);
   attempted=true;
   IoRequire(status==0&&block.Status==IntPtr.Zero&&(block.Information.ToUInt64()==1||block.Information.ToUInt64()==2)&&lockHandle!=null&&!lockHandle.IsInvalid);
   string lockPath=IoChild(parentPath,JsAdmissionLockName);
   IoInspect(lockHandle,false);
   IoFileProof(lockHandle,lockPath,r,sid,0,null);
   IoAclProof(lockHandle,sid,true);
   IoNtfsProof(lockHandle);
   var admission=new JsAdmission {Lock=lockHandle};
   if(inventory)JsInventoryParent(parentPath,r,sid,admission);
   IoRequire(JsGetDiskFreeSpaceExW(parentPath,out ulong free,out ulong _,out ulong _));
   admission.FreeSpace=free;
   return admission;
  }catch{lockHandle?.Dispose();throw;}
  finally{
   if(descriptor!=IntPtr.Zero)IoLocalFree(descriptor);
   if(nameBuffer!=IntPtr.Zero)Marshal.FreeHGlobal(nameBuffer);
   if(nameObject!=IntPtr.Zero)Marshal.FreeHGlobal(nameObject);
  }
 }
 // Bounded, fail-closed .folio-hot-* inventory under the held lock. Unknown
 // names, nested entries or over-limit dirs reject; each listed file is
 // proven on a held handle. At most 4 slots + 16 archives + 64 captures + 1 lock.
 static List<string> JsList(string path,string pattern,int maximum){
  var result=new List<string>();
  foreach(string item in Directory.EnumerateFileSystemEntries(path,pattern)){
   IoRequire(result.Count<maximum);
   result.Add(item);
  }
  return result;
 }
 static void JsInventoryParent(string parentPath,IoRequest r,string sid,JsAdmission admission){
  List<string> entries;
  try{entries=JsList(parentPath,".folio-hot-*",JsSnapshotSlots+JsMaxArchives+JsMaxCaptures+1);}
  catch{IoRequire(false);return;}
  int slots=0;
  foreach(string entry in entries){
   string name=System.IO.Path.GetFileName(entry);
   if(name==JsAdmissionLockName){
    // The owned lock is already held exclusively — never reopen it.
    IoFileProof(admission.Lock,entry,r,sid,0,null);
    continue;
   }
   if(name.StartsWith(JsCapturePrefix,StringComparison.Ordinal)){
    IoRequire(name.Length==JsCapturePrefix.Length+32);
    foreach(char c in name.Substring(JsCapturePrefix.Length))IoRequire((c>='0'&&c<='9')||(c>='a'&&c<='f'));
    long captureActual=JsInventoryCapture(entry,r,sid);
    admission.Captures++;
    admission.Actual=checked(admission.Actual+captureActual);
    // Incomplete/UNKNOWN captures retain their FULL reservation, including
    // after restart. No receipt absence releases bytes or grants a retry.
    admission.Retained=checked(admission.Retained+JsCaptureReserveBytes);
    continue;
   }
   bool isSlot=name.Length==JsSlotPrefix.Length+1&&name.StartsWith(JsSlotPrefix,StringComparison.Ordinal)&&name[JsSlotPrefix.Length]>='0'&&name[JsSlotPrefix.Length]<'0'+JsSnapshotSlots;
   bool isArchive=name.Length==JsArchivePrefix.Length+32&&name.StartsWith(JsArchivePrefix,StringComparison.Ordinal);
   if(isArchive)foreach(char c in name.Substring(JsArchivePrefix.Length))IoRequire((c>='0'&&c<='9')||(c>='a'&&c<='f'));
   IoRequire(isSlot||isArchive);
   long actual=0;
   using(var dir=JsOpenPrivate(entry,r,sid,false)){
    IoInspect(dir,true);
    IoProof(dir,entry,r,sid);
    IoAclProof(dir,sid,true);
    IoNtfsProof(dir);
    List<string> children;
    try{children=JsList(entry,"*",JsSlotFileNames.Length);}
    catch{IoRequire(false);return;}
    var seen=new HashSet<string>(StringComparer.Ordinal);
    foreach(string child in children){
     string childName=System.IO.Path.GetFileName(child);
     IoRequire(seen.Add(childName));
     bool known=false;
     foreach(string allowed in JsSlotFileNames)if(childName==allowed){known=true;break;}
     IoRequire(known);
     using(var file=JsOpenPrivate(child,r,sid,true)){
      var standard=IoInspect(file,false);
      IoRequire(standard.EndOfFile>=0&&standard.EndOfFile<=JsProfiles[2].CombinedBytes);
      IoFileProof(file,child,r,sid,standard.EndOfFile,null);
      IoAclProof(file,sid,true);
      IoNtfsProof(file);
      actual=checked(actual+standard.EndOfFile);
     }
    }
   }
   admission.Actual=checked(admission.Actual+actual);
   long charge=checked(actual+JsLifecycleReserveBytes);
   if(isSlot){
    long cap=JsProfiles[2].CombinedBytes;
    try{
     using var intent=JsonDocument.Parse(JsReadPrivate(IoChild(entry,"intent.json"),r,sid,JsMaxReceiptBytes));
     JsStrictJson(intent.RootElement);
     cap=JsProfileFor(IoString(intent.RootElement.GetProperty("profile"))).CombinedBytes;
    }catch{}
    charge=Math.Max(actual,2*cap+JsLifecycleReserveBytes);
   }
   admission.Retained=checked(admission.Retained+charge);
   if(isSlot)slots++;else admission.Archives++;
  }
  IoRequire(slots<=JsSnapshotSlots&&admission.Archives<=JsMaxArchives&&admission.Captures<=JsMaxCaptures);
 }
 static bool JsCorePhase(string phase){
  return phase=="snapshot"||phase=="revalidate"||phase=="seal"||phase=="inspect"||phase=="release"||phase=="commit-release-evidence";
 }
 static byte[] JsRawComponent(JsonElement value){
  string encoded=IoString(value);
  IoRequire(encoded.Length<=2*JsMaxStdinBytes);
  byte[] bytes=Convert.FromBase64String(encoded);
  IoRequire(bytes.Length<=JsMaxStdinBytes&&Convert.ToBase64String(bytes)==encoded);
  return bytes;
 }
 static string JsWireName(int index){return "wire-"+index.ToString("D2",System.Globalization.CultureInfo.InvariantCulture)+".bin";}
 static bool JsCaptureName(string name){
  if(name=="intent.json"||name=="ready.json"||name=="output.json"||name=="stdout.bin"||name=="stderr.bin"||name=="metadata.bin")return true;
  for(int i=0;i<16;i++)if(name==JsWireName(i))return true;
  return false;
 }
 static long JsInventoryCapture(string path,IoRequest r,string sid){
  using var directory=JsOpenPrivate(path,r,sid,false);
  JsProveSlot(directory,path,r,sid);
  long actual=0;
  foreach(string file in JsList(path,"*",22)){
   IoRequire(JsCaptureName(System.IO.Path.GetFileName(file)));
   using var handle=JsOpenPrivate(file,r,sid,true);
   var standard=IoInspect(handle,false);
   IoRequire(standard.EndOfFile>=0&&standard.EndOfFile<=JsMaxStdinBytes);
   IoFileProof(handle,file,r,sid,standard.EndOfFile,null);
   IoAclProof(handle,sid,true);IoNtfsProof(handle);
   actual=checked(actual+standard.EndOfFile);
  }
  IoRequire(actual<=JsCaptureReserveBytes);
  return actual;
 }
 // Evidence writer, independent of source main/sidecars and SQLite semantics.
 // Every component is a fixed child of the held, proven private directory.
 // Native FILE_CREATE never opens/overwrites an existing component.
 static void JsWriteCaptureFile(SafeFileHandle directory,string path,string name,byte[] bytes,IoRequest r,string sid){
  IoRequire(JsCaptureName(name)&&bytes.Length<=JsMaxStdinBytes);
  byte[] nameBytes=System.Text.Encoding.Unicode.GetBytes(name);
  IntPtr descriptor=IntPtr.Zero,nameBuffer=IntPtr.Zero,nameObject=IntPtr.Zero;
  SafeFileHandle file=null;
  try{
   IoRequire(IoConvertSecurityDescriptor("O:"+sid+"G:"+sid+"D:P(A;;FA;;;"+sid+")",1,out descriptor,out _));
   nameBuffer=Marshal.AllocHGlobal(nameBytes.Length);Marshal.Copy(nameBytes,0,nameBuffer,nameBytes.Length);
   var unicode=new JS_UNICODE_STRING{Length=checked((ushort)nameBytes.Length),MaximumLength=checked((ushort)nameBytes.Length),Buffer=nameBuffer};
   nameObject=Marshal.AllocHGlobal(Marshal.SizeOf<JS_UNICODE_STRING>());Marshal.StructureToPtr(unicode,nameObject,false);
   var attributes=new JS_OBJECT_ATTRIBUTES{Length=(uint)Marshal.SizeOf<JS_OBJECT_ATTRIBUTES>(),RootDirectory=directory.DangerousGetHandle(),ObjectName=nameObject,Attributes=0x40,SecurityDescriptor=descriptor};
   int status=JsNtCreateFile(out file,IoGenericRead|IoGenericWrite|IoReadControl|IoSynchronize,ref attributes,out IO_STATUS_BLOCK block,IntPtr.Zero,0,IoShareRead,JsFileCreate,JsFileNonDirectory|IoFileSynchronousIoNonAlert|IoFileOpenReparsePoint|2,IntPtr.Zero,0);
   IoRequire(status==0&&block.Status==IntPtr.Zero&&block.Information.ToUInt64()==2&&file!=null&&!file.IsInvalid);
   string target=IoCanonical(IoChild(path,name));
   var first=IoFileProof(file,target,r,sid,0,null);
   IoAclProof(file,sid,true);IoNtfsProof(file);
   using(var stream=new FileStream(file,FileAccess.ReadWrite,4096,false)){
    stream.Write(bytes,0,bytes.Length);stream.Flush(true);
    byte[] readback=IoReadExact(stream,bytes.Length,JsMaxStdinBytes);
    IoRequire(System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(bytes,readback));
    IoFileProof(file,target,r,sid,bytes.Length,first.fileId);
    IoAclProof(file,sid,true);IoNtfsProof(file);stream.Flush(true);
   }
  }finally{
   file?.Dispose();
   if(descriptor!=IntPtr.Zero)IoLocalFree(descriptor);
   if(nameBuffer!=IntPtr.Zero)Marshal.FreeHGlobal(nameBuffer);
   if(nameObject!=IntPtr.Zero)Marshal.FreeHGlobal(nameObject);
  }
 }
 static byte[] JsCaptureIntent(JsRequest request,string captureFileId){
  IoRequest r=request.Common;
  return JsonSerializer.SerializeToUtf8Bytes(new {
   version=1,operation="capture-intent",path=r.Path,root=r.Root,attemptId=r.AttemptId,profile=request.Profile,
   rootFileId=r.RootFileId,rootVolumeId=r.RootVolumeId,directoryFileId=r.DirectoryFileId,directoryVolumeId=r.DirectoryVolumeId,
   fileId=r.FileId,volumeId=r.VolumeId,captureId=request.CaptureId,capturePhase=request.CapturePhase,captureFileId,
   wireByteLength=request.CaptureWireLength,wireSha256=request.CaptureWireHash
  });
 }
 static void JsCheckCaptureIntent(string path,JsRequest request,string sid){
  // Compare our own fixed metadata, never parse the captured caller wire.
  byte[] expected=JsCaptureIntent(request,request.CaptureFileId);
  byte[] actual=JsReadPrivate(IoChild(path,"intent.json"),request.Common,sid,JsMaxStdinBytes);
  IoRequire(System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(expected,actual));
 }
 static void JsCheckCaptureWire(string path,JsRequest request,string sid){
  using var hash=System.Security.Cryptography.IncrementalHash.CreateHash(System.Security.Cryptography.HashAlgorithmName.SHA256);
  int remaining=request.CaptureWireLength;
  for(int index=0;remaining>0;index++){
   byte[] bytes=JsReadPrivate(IoChild(path,JsWireName(index)),request.Common,sid,JsMaxStdinBytes);
   IoRequire(bytes.Length==Math.Min(remaining,JsMaxStdinBytes));
   hash.AppendData(bytes);remaining-=bytes.Length;
  }
  IoRequire(Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant()==request.CaptureWireHash);
 }
 static byte[] JsCaptureReady(JsRequest request){
  return JsonSerializer.SerializeToUtf8Bytes(new {version=1,captureId=request.CaptureId,captureFileId=request.CaptureFileId,wireByteLength=request.CaptureWireLength,wireSha256=request.CaptureWireHash});
 }
 static JsOutcome JsCapture(JsRequest request,string sid,IoDirectoryLocks directories,ref bool attempted){
  IoRequest r=request.Common;
  string path=IoCanonical(IoChild(r.Parent,JsCapturePrefix+request.CaptureId));
  directories.RecheckExclusive();
  JsProveDirectory(directories.RootHandle,r.Root,r,sid);
  JsProveDirectory(directories.ParentHandle,r.Parent,r,sid);
  bool begin=r.Operation=="capture-intent";
  // Only admission inspects the whole bounded namespace. Appending already
  // reserved raw evidence must work even when the source operation left an
  // incomplete slot or the main database now fails semantic/identity checks.
  using var admission=JsAcquireAdmission(directories.ParentHandle,r.Parent,r,sid,ref attempted,begin);
  SafeFileHandle capture=null;
  try{
   FolioWindowsProbeResult proof;
   if(begin){
    IoRequire(admission.Captures<JsMaxCaptures&&admission.Retained+JsCaptureReserveBytes<=JsRetainedBudgetBytes);
    IoRequire(admission.FreeSpace>=(ulong)(Math.Max(0,admission.Retained-admission.Actual)+JsCaptureReserveBytes+JsFreeReserveBytes));
    capture=JsCreateSlot(directories.ParentHandle,JsCapturePrefix+request.CaptureId,sid,ref attempted);
    IoRequire(capture!=null); // Collision is NOT adoption/resume/retry.
    proof=JsProveSlot(capture,path,r,sid);
    request.CaptureFileId=proof.fileId;
    JsWriteCaptureFile(capture,path,"intent.json",JsCaptureIntent(request,proof.fileId),r,sid);
   }else{
    attempted=true;
    capture=JsOpenSlot(path,r,sid,request.CaptureFileId,out proof);
    JsInventoryCapture(path,r,sid);
    JsCheckCaptureIntent(path,request,sid);
    if(r.Operation=="capture-wire"){
     IoRequire(!JsSlotEntryExists(path,"ready.json",r,sid)&&!JsSlotEntryExists(path,"output.json",r,sid));
     JsWriteCaptureFile(capture,path,JsWireName(request.CaptureIndex),request.CaptureBytes,r,sid);
    }else{
     JsCheckCaptureWire(path,request,sid);
     byte[] ready=JsCaptureReady(request);
     if(r.Operation=="capture-ready")JsWriteCaptureFile(capture,path,"ready.json",ready,r,sid);
     else{
      IoRequire(System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(ready,JsReadPrivate(IoChild(path,"ready.json"),r,sid,JsMaxStdinBytes)));
      // Bytes are opaque, including malformed JSON, invalid UTF8, failures,
      // signals and limit errors. They never select a path or a source action.
      JsWriteCaptureFile(capture,path,"stdout.bin",request.CaptureStdout,r,sid);
      JsWriteCaptureFile(capture,path,"stderr.bin",request.CaptureStderr,r,sid);
      JsWriteCaptureFile(capture,path,"metadata.bin",request.CaptureMetadata,r,sid);
      JsWriteCaptureFile(capture,path,"output.json",JsonSerializer.SerializeToUtf8Bytes(new {
       version=1,captureId=request.CaptureId,captureFileId=request.CaptureFileId,
       wireByteLength=request.CaptureWireLength,wireSha256=request.CaptureWireHash,
       stdoutByteLength=request.CaptureStdout.Length,stdoutSha256=IoSha256(request.CaptureStdout),
       stderrByteLength=request.CaptureStderr.Length,stderrSha256=IoSha256(request.CaptureStderr),
       metadataByteLength=request.CaptureMetadata.Length,metadataSha256=IoSha256(request.CaptureMetadata)
      }),r,sid);
     }
    }
   }
   JsProveSlot(capture,path,r,sid,request.CaptureFileId);
   return new JsOutcome {Status=0,Response=new {
    version=1,operation=r.Operation,state="CAPTURE_ACK",path=r.Path,root=r.Root,profile=request.Profile,attemptId=r.AttemptId,
    captureId=request.CaptureId,capturePhase=request.CapturePhase,requestSha256=IoSha256(request.Encoded),
    directory=IoEvidence(directories.RecheckExclusive(),sid),captureDirectory=IoEvidence(proof,sid)
   }};
  }finally{capture?.Dispose();}
 }
 // Path-based read-only open used only for inventory of owned names under
 // the already-locked, proven parent; every entry is re-proved on the
 // returned handle before use.
 static SafeFileHandle JsOpenPrivate(string path,IoRequest r,string sid,bool file){
  IntPtr raw=CreateFileW(path,IoGenericRead|IoReadControl,IoShareRead,IntPtr.Zero,OpenExisting,(file?0:FileFlagBackupSemantics)|FileFlagOpenReparsePoint,IntPtr.Zero);
  IoRequire(raw!=new IntPtr(-1));
  return new SafeFileHandle(raw,true);
 }
 // Full slot inventory for lifecycle operations: every allowed file
 // proven+hashed on a held handle. Unknown names are reported via `extra`.
 static List<JsNamedEntry> JsInventorySlot(string slotPath,IoRequest r,string sid,out bool extra){
  var entries=new List<JsNamedEntry>();
  extra=false;
  List<string> children;
  try{children=JsList(slotPath,"*",JsSlotFileNames.Length);}
  catch{IoRequire(false);return null;}
  var seen=new HashSet<string>(StringComparer.Ordinal);
  foreach(string child in children){
   string name=System.IO.Path.GetFileName(child);
   IoRequire(seen.Add(name));
   bool known=false;
   foreach(string allowed in JsSlotFileNames)if(name==allowed){known=true;break;}
   if(!known){extra=true;continue;}
   entries.Add(JsHashPrivate(name,child,r,sid,-1));
  }
  return entries;
 }
 // Deterministic lifecycle fingerprint: profile, attempt and slot IDs, the
 // CURRENT source manifest/IDs, receipt file IDs+hashes, and the raw and
 // working file ID/length/hash/presence sets.
 static string JsFingerprint(JsRequest request,int slot,string slotFileId,string slotVolumeId,List<JsSource> sources,List<JsNamedEntry> files){
  var text=new System.Text.StringBuilder();
  text.Append(request.Profile).Append('\n').Append(request.Common.AttemptId).Append('\n')
   .Append(slot).Append('\n').Append(slotFileId??"").Append('\n').Append(slotVolumeId??"").Append('\n');
  foreach(var s in sources)
   text.Append("source|").Append(s.Suffix).Append('|').Append(s.Present?"1":"0").Append('|')
    .Append(s.Present?s.Proof.fileId:"").Append('|').Append(s.Present?s.Proof.volumeId:"").Append('|')
    .Append(s.Present?s.Length.ToString():"").Append('|').Append(s.Present?s.Sha256:"").Append('\n');
  files.Sort((a,b)=>string.CompareOrdinal(a.Name,b.Name));
  foreach(var f in files)
   text.Append("file|").Append(f.Name).Append('|').Append(f.Present?"1":"0").Append('|')
    .Append(f.FileId).Append('|').Append(f.VolumeId).Append('|').Append(f.Length).Append('|').Append(f.Sha256).Append('\n');
  return Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(text.ToString()))).ToLowerInvariant();
 }
 static bool JsSlotEntryExists(string slotPath,string name,IoRequest r,string sid){
  IntPtr raw=CreateFileW(IoChild(slotPath,name),IoGenericRead|IoReadControl,IoShareRead,IntPtr.Zero,OpenExisting,FileFlagOpenReparsePoint,IntPtr.Zero);
  if(raw==new IntPtr(-1)){
   int error=Marshal.GetLastWin32Error();
   IoRequire(error==JsErrorFileNotFound);
   return false;
  }
  using(var handle=new SafeFileHandle(raw,true)){
   var standard=IoInspect(handle,false);
   IoFileProof(handle,IoChild(slotPath,name),r,sid,standard.EndOfFile,null);
   return true;
  }
 }
 // These records authorize disposal, so every nesting level rejects duplicate
 // keys before any typed field is read. Metadata remains independently bounded.
 static void JsStrictJson(JsonElement value,int depth=0){
  IoRequire(depth<=12);
  if(value.ValueKind==JsonValueKind.Object){
   var names=new HashSet<string>(StringComparer.Ordinal);
   foreach(var p in value.EnumerateObject()){
    IoRequire(names.Count<32&&names.Add(p.Name));
    JsStrictJson(p.Value,depth+1);
   }
  }else if(value.ValueKind==JsonValueKind.Array){
   IoRequire(value.GetArrayLength()<=16);
   foreach(var item in value.EnumerateArray())JsStrictJson(item,depth+1);
  }
 }
 static void JsKeys(JsonElement obj,params string[] keys){
  IoRequire(obj.ValueKind==JsonValueKind.Object);
  JsStrictJson(obj);
  var names=new HashSet<string>(keys,StringComparer.Ordinal);
  int count=0;
  foreach(var p in obj.EnumerateObject()){IoRequire(names.Contains(p.Name));count++;}
  IoRequire(count==names.Count);
 }
 static byte[] JsCapturedBytes(JsonElement phase,string name){
  JsKeys(phase,"request","response","stderr");
  JsonElement part=phase.GetProperty(name);
  JsKeys(part,"value","byteLength","sha256");
  string encoded=IoString(part.GetProperty("value"));
  IoRequire(encoded.Length<=2*JsMaxReceiptBytes);
  byte[] bytes=Convert.FromBase64String(encoded);
  IoRequire(bytes.Length<=JsMaxReceiptBytes&&Convert.ToBase64String(bytes)==encoded);
  IoRequire(part.GetProperty("byteLength").GetInt64()==bytes.Length&&IoHex(part.GetProperty("sha256"),64,true)==IoSha256(bytes));
  return bytes;
 }
 static void JsEnvelope(JsonElement obj,JsRequest request,string operation,string state=null){
  JsStrictJson(obj);
  IoRequest r=request.Common;
  IoRequire(obj.GetProperty("version").GetInt32()==1&&IoString(obj.GetProperty("operation"))==operation);
  IoRequire(IoString(obj.GetProperty("path"))==r.Path&&IoString(obj.GetProperty("root"))==r.Root);
  IoRequire(IoString(obj.GetProperty("profile"))==request.Profile&&IoHex(obj.GetProperty("attemptId"),32,true)==r.AttemptId);
  if(state!=null)IoRequire(IoString(obj.GetProperty("state"))==state);
 }
 static void JsCapturedProof(JsonElement proof,string path,string fileId,IoRequest r,string sid){
  JsKeys(proof,"canonicalPath","canonicalRoot","daclPrivate","fileId","linkCount","localFilesystem","ownerSid","platform","reparsePoint","rootFileId","rootVolumeId","sid","volumeId");
  IoRequire(IoString(proof.GetProperty("canonicalPath"))==path&&IoString(proof.GetProperty("canonicalRoot"))==r.Root);
  IoRequire(Same(IoHex(proof.GetProperty("fileId"),32),fileId)&&Same(IoHex(proof.GetProperty("volumeId"),16),r.VolumeId));
  IoRequire(Same(IoHex(proof.GetProperty("rootFileId"),32),r.RootFileId)&&Same(IoHex(proof.GetProperty("rootVolumeId"),16),r.RootVolumeId));
  IoRequire(IoString(proof.GetProperty("sid"))==sid&&IoString(proof.GetProperty("ownerSid"))==sid&&IoString(proof.GetProperty("platform"))=="win32");
  IoRequire(proof.GetProperty("daclPrivate").GetBoolean()&&proof.GetProperty("localFilesystem").GetBoolean()&&!proof.GetProperty("reparsePoint").GetBoolean()&&proof.GetProperty("linkCount").GetInt32()==1);
 }
 static void JsValidatePhase(JsonElement phase,JsRequest request,string operation,FolioWindowsProbeResult slotProof,List<JsExpectation> expected,string sid){
  IoRequest r=request.Common;
  IoRequire(JsCapturedBytes(phase,"stderr").Length==0);
  using var requestDoc=JsonDocument.Parse(JsCapturedBytes(phase,"request"));
  using var responseDoc=JsonDocument.Parse(JsCapturedBytes(phase,"response"));
  JsonElement wire=requestDoc.RootElement,reply=responseDoc.RootElement;
  JsEnvelope(wire,request,operation);
  JsEnvelope(reply,request,operation,operation=="snapshot"?"SNAPSHOT":"REVALIDATED");
  IoRequire(Same(IoHex(wire.GetProperty("rootFileId"),32),r.RootFileId)&&Same(IoHex(wire.GetProperty("rootVolumeId"),16),r.RootVolumeId));
  IoRequire(Same(IoHex(wire.GetProperty("directoryFileId"),32),r.DirectoryFileId)&&Same(IoHex(wire.GetProperty("directoryVolumeId"),16),r.DirectoryVolumeId));
  IoRequire(Same(IoHex(wire.GetProperty("fileId"),32),r.FileId)&&Same(IoHex(wire.GetProperty("volumeId"),16),r.VolumeId));
  IoRequire(reply.GetProperty("slot").GetInt32()==request.Slot);
  if(operation=="revalidate"){
   IoRequire(wire.GetProperty("slot").GetInt32()==request.Slot&&Same(IoHex(wire.GetProperty("slotFileId"),32),slotProof.fileId)&&Same(IoHex(wire.GetProperty("slotVolumeId"),16),slotProof.volumeId));
  }else{
   string slotPath=IoChild(r.Parent,JsSlotPrefix+request.Slot);
   IoRequire(IoString(reply.GetProperty("snapshotDirectory"))==slotPath&&IoString(reply.GetProperty("snapshotPath"))==IoChild(slotPath,"snapshot.sqlite"));
  }
  JsCapturedProof(reply.GetProperty("directory"),r.Parent,r.DirectoryFileId,r,sid);
  JsCapturedProof(reply.GetProperty("slotDirectory"),IoChild(r.Parent,JsSlotPrefix+request.Slot),slotProof.fileId,r,sid);
  JsonElement items=reply.GetProperty("sources");
  IoRequire(items.ValueKind==JsonValueKind.Array&&items.GetArrayLength()==4);
  for(int i=0;i<4;i++){
   var item=items[i];var e=expected[i];
   IoRequire(IoString(item.GetProperty("suffix"))==e.Suffix&&item.GetProperty("present").GetBoolean()==e.Present);
   if(!e.Present){JsKeys(item,"suffix","present");continue;}
   JsKeys(item,"suffix","present","byteLength","sha256","evidence");
   IoRequire(item.GetProperty("byteLength").GetInt64()==e.Length&&IoHex(item.GetProperty("sha256"),64,true)==e.Sha256);
   JsCapturedProof(item.GetProperty("evidence"),r.Path+e.Suffix,e.FileId,r,sid);
  }
 }
 static void JsSameExpectations(List<JsExpectation> a,List<JsExpectation> b){
  IoRequire(a.Count==b.Count);
  for(int i=0;i<a.Count;i++)IoRequire(a[i].Present==b[i].Present&&Same(a[i].FileId,b[i].FileId)&&Same(a[i].VolumeId,b[i].VolumeId)&&a[i].Length==b[i].Length&&a[i].Sha256==b[i].Sha256);
 }
 static List<JsExpectation> JsValidateLifecycle(string path,JsRequest request,FolioWindowsProbeResult slotProof,List<JsNamedEntry> files,string sid,bool released=false){
  IoRequest r=request.Common;
  IoRequire(!JsSlotEntryExists(path,"revalidation-failed.json",r,sid));
  if(!released)IoRequire(!JsSlotEntryExists(path,"release-intent.json",r,sid)&&!JsSlotEntryExists(path,"released.json",r,sid));
  var intent=JsParseIntent(JsReadPrivate(IoChild(path,"intent.json"),r,sid,JsMaxReceiptBytes),request,request.Slot,slotProof,"snapshot","INTENT");
  var prepared=JsParseIntent(JsReadPrivate(IoChild(path,"prepared.json"),r,sid,JsMaxReceiptBytes),request,request.Slot,slotProof,"snapshot","PREPARED");
  var revalidated=JsParseIntent(JsReadPrivate(IoChild(path,"revalidated.json"),r,sid,JsMaxReceiptBytes),request,request.Slot,slotProof,"revalidate","REVALIDATED");
  JsSameExpectations(intent,prepared);JsSameExpectations(intent,revalidated);
  using var captured=JsonDocument.Parse(JsReadPrivate(IoChild(path,"captures.json"),r,sid,JsMaxLifecycleStdinBytes));
  var value=captured.RootElement;
  JsKeys(value,"version","operation","state","path","root","profile","attemptId","slot","snapshot","revalidate");
  JsEnvelope(value,request,"seal","SEALED");IoRequire(value.GetProperty("slot").GetInt32()==request.Slot);
  JsValidatePhase(value.GetProperty("snapshot"),request,"snapshot",slotProof,intent,sid);
  JsValidatePhase(value.GetProperty("revalidate"),request,"revalidate",slotProof,intent,sid);
  foreach(var e in intent){
   JsNamedEntry rawCopy=null;
   foreach(var f in files)if(f.Name=="source.sqlite"+e.Suffix)rawCopy=f;
   IoRequire(e.Present==(rawCopy!=null));
   if(e.Present)IoRequire(rawCopy.Length==e.Length&&rawCopy.Sha256==e.Sha256);
  }
  return intent;
 }
 // SEAL: persist the exact captured snapshot/revalidate request wires and
 // pipe bytes (base64) as immutable captures.json after reproving source
 // and slot receipts. Bounded by the 1MiB lifecycle stdin cap.
 static JsOutcome JsSeal(JsRequest request,string sid,IoDirectoryLocks directories,ref bool attempted){
  IoRequest r=request.Common;
  attempted=true;
  string slotPath=IoChild(r.Parent,JsSlotPrefix+request.Slot);
  SafeFileHandle slotHandle=null;
  var sources=new List<JsSource>();
  using var admission=JsAcquireAdmission(directories.ParentHandle,r.Parent,r,sid,ref attempted);
  try{
   directories.RecheckExclusive();
   slotHandle=JsOpenSlot(slotPath,r,sid,request.SlotFileId,out var slotProof);
   IoRequire(Same(slotProof.volumeId,request.SlotVolumeId));
   JsProveDirectory(directories.ParentHandle,r.Parent,r,sid);
   JsProveDirectory(directories.RootHandle,r.Root,r,sid);
   IoRequire(!JsSlotEntryExists(slotPath,"captures.json",r,sid));
   IoRequire(!JsSlotEntryExists(slotPath,"revalidation-failed.json",r,sid));
   IoRequire(!JsSlotEntryExists(slotPath,"release-intent.json",r,sid));
   var intent=JsParseIntent(JsReadPrivate(IoChild(slotPath,"intent.json"),r,sid,JsMaxReceiptBytes),request,request.Slot,slotProof,"snapshot","INTENT");
   var prepared=JsParseIntent(JsReadPrivate(IoChild(slotPath,"prepared.json"),r,sid,JsMaxReceiptBytes),request,request.Slot,slotProof,"snapshot","PREPARED");
   var revalidated=JsParseIntent(JsReadPrivate(IoChild(slotPath,"revalidated.json"),r,sid,JsMaxReceiptBytes),request,request.Slot,slotProof,"revalidate","REVALIDATED");
   JsSameExpectations(intent,prepared);JsSameExpectations(intent,revalidated);
   // The captured pipes are the request's exact request/response bytes.
   var snapshot=request.Captures["snapshot"];
   var revalidate=request.Captures["revalidate"];
   JsValidatePhase(snapshot,request,"snapshot",slotProof,intent,sid);
   JsValidatePhase(revalidate,request,"revalidate",slotProof,intent,sid);
   for(int i=0;i<4;i++){
    var s=JsOpenSource(r,sid,JsSuffixes[i],i==0,JsProfileFor(request.Profile));sources.Add(s);
    var e=intent[i];IoRequire(s.Present==e.Present);
    if(s.Present)IoRequire(Same(s.Proof.fileId,e.FileId)&&Same(s.Proof.volumeId,e.VolumeId)&&s.Length==e.Length&&s.Sha256==e.Sha256);
   }
   var captures=new {version=1,operation="seal",state="SEALED",path=r.Path,root=r.Root,profile=request.Profile,attemptId=r.AttemptId,slot=request.Slot,
    snapshot=JsonSerializer.Deserialize<Dictionary<string,JsonElement>>(snapshot.GetRawText()),
    revalidate=JsonSerializer.Deserialize<Dictionary<string,JsonElement>>(revalidate.GetRawText())};
   JsWriteNewFile(IoChild(slotPath,"captures.json"),JsonSerializer.SerializeToUtf8Bytes(captures),r,sid);
   JsRecheckSources(r,sid,sources);
   directories.RecheckExclusive();
   JsProveSlot(slotHandle,slotPath,r,sid,request.SlotFileId);
   return new JsOutcome {Status=0,Response=new {
    version=1,operation="seal",state="SEALED",path=r.Path,root=r.Root,profile=request.Profile,attemptId=r.AttemptId,slot=request.Slot,
    directory=IoEvidence(directories.RecheckExclusive(),sid),slotDirectory=IoEvidence(slotProof,sid)
   }};
  }finally{try{slotHandle?.Dispose();}finally{JsDisposeSources(sources);}}
 }
 // INSPECTION: read durable evidence and compute the deterministic
 // fingerprint over the CURRENT source manifest, slot IDs and retained
 // files. A missing slot or incomplete lifecycle reports state UNKNOWN;
 // it never promotes on a merely missing receipt.
 static JsOutcome JsInspect(JsRequest request,string sid,IoDirectoryLocks directories,ref bool attempted){
  IoRequest r=request.Common;
  attempted=true;
  string slotPath=IoChild(r.Parent,request.Archived?JsArchivePrefix+r.AttemptId:JsSlotPrefix+request.Slot);
  JsProfile profile=JsProfileFor(request.Profile);
  using(var admission=JsAcquireAdmission(directories.ParentHandle,r.Parent,r,sid,ref attempted)){
   directories.RecheckExclusive();
   string inspectionState="UNKNOWN";
   string fingerprint;
   List<JsSource> sources=new List<JsSource>();
   List<JsNamedEntry> files=new List<JsNamedEntry>();
   try{
    IntPtr raw=CreateFileW(slotPath,FileReadAttributes|IoReadControl,IoShareRead,IntPtr.Zero,OpenExisting,FileFlagBackupSemantics|FileFlagOpenReparsePoint,IntPtr.Zero);
    if(raw==new IntPtr(-1)){
     IoRequire(Marshal.GetLastWin32Error()==JsErrorFileNotFound);
     fingerprint=JsFingerprint(request,request.Slot,"","",sources,files);
     return new JsOutcome {Status=0,Response=JsInspectReply(request,inspectionState,fingerprint,sources,files,null,directories,sid,false)};
    }
    using(var slotHandle=new SafeFileHandle(raw,true)){
     var slotProof=JsProveSlot(slotHandle,slotPath,r,sid);
     IoRequire(Same(slotProof.fileId,request.SlotFileId)&&Same(slotProof.volumeId,request.SlotVolumeId));
     JsProveDirectory(directories.ParentHandle,r.Parent,r,sid);
     JsProveDirectory(directories.RootHandle,r.Root,r,sid);
     bool extra;
     files=JsInventorySlot(slotPath,r,sid,out extra);
     for(int index=0;index<JsSuffixes.Length;index++)
      sources.Add(JsOpenSource(r,sid,JsSuffixes[index],false,profile));
     fingerprint=JsFingerprint(request,request.Slot,slotProof.fileId,slotProof.volumeId,sources,files);
     if(!extra){
      bool complete=false;
      try{
       JsValidateLifecycle(slotPath,request,slotProof,files,sid,request.Archived);
       IoRequire(sources[0].Present);
       long total=0;foreach(var source in sources)if(source.Present)total=checked(total+source.Length);
       IoRequire(total<=profile.CombinedBytes);
       if(request.Archived){
        using var terminal=JsonDocument.Parse(JsReadPrivate(IoChild(slotPath,"release-capture.json"),r,sid,JsMaxLifecycleStdinBytes));
        JsValidateReleaseCapture(terminal.RootElement,request,slotPath,slotProof,sid);
       }
       JsRecheckSources(r,sid,sources);
       complete=true;
      }catch{complete=false;}
      if(complete)inspectionState=request.Archived?"RELEASED":"REVALIDATED";
     }
     directories.RecheckExclusive();
     JsProveSlot(slotHandle,slotPath,r,sid,request.SlotFileId);
     return new JsOutcome {Status=0,Response=JsInspectReply(request,inspectionState,fingerprint,sources,files,slotProof,directories,sid,true)};
    }
   }finally{JsDisposeSources(sources);}
  }
 }
 static object JsInspectReply(JsRequest request,string inspectionState,string fingerprint,List<JsSource> sources,List<JsNamedEntry> files,FolioWindowsProbeResult slotProof,IoDirectoryLocks directories,string sid,bool slotPresent){
  IoRequest r=request.Common;
  var receipts=new List<object>();
  var named=new List<object>();
  foreach(var f in files)
   named.Add(new {name=f.Name,present=f.Present,fileId=f.FileId,volumeId=f.VolumeId,byteLength=f.Length,sha256=f.Sha256});
  var sourcesReply=new List<object>();
  foreach(var s in sources)
   sourcesReply.Add(s.Present
    ?(object)new {suffix=s.Suffix,present=true,byteLength=s.Length,sha256=s.Sha256,evidence=IoEvidence(s.Proof,sid)}
    :new {suffix=s.Suffix,present=false});
  return new {version=1,operation="inspect",state="INSPECTED",path=r.Path,root=r.Root,profile=request.Profile,attemptId=r.AttemptId,slot=request.Slot,
   inspectionState,fingerprint,
   evidence=new {reference=new {attemptId=r.AttemptId,slot=request.Slot,slotFileId=request.SlotFileId,slotVolumeId=request.SlotVolumeId},
    sources=sourcesReply,files=named,directory=IoEvidence(directories.RecheckExclusive(),sid),
    slotDirectory=slotPresent?(object)IoEvidence(slotProof,sid):null}};
 }
 // RELEASE: explicit operator resolution only. Re-inspects everything under
 // the serialized admission lock, compares the exact inspection fingerprint,
 // writes the immutable release-intent BEFORE the first deletion, then
 // disposes only the fixed snapshot.sqlite{suffix} working files via held
 // DELETE handles and renames the evidence-only slot to its archive name.
 // Partial release leaves UNKNOWN plus the immutable release-intent; there
 // is no automatic retry or recursive cleanup.
 static JsOutcome JsRelease(JsRequest request,string sid,IoDirectoryLocks directories,ref bool attempted){
  IoRequest r=request.Common;
  attempted=true;
  JsProfile profile=JsProfileFor(request.Profile);
  string slotPath=IoChild(r.Parent,JsSlotPrefix+request.Slot);
  string archivePath=IoChild(r.Parent,JsArchivePrefix+r.AttemptId);
  IoCanonical(archivePath);
  using(var admission=JsAcquireAdmission(directories.ParentHandle,r.Parent,r,sid,ref attempted)){
   IoRequire(admission.Archives<JsMaxArchives&&admission.Retained<=JsRetainedBudgetBytes);
   IoRequire(admission.FreeSpace>=(ulong)(Math.Max(0,admission.Retained-admission.Actual)+JsFreeReserveBytes));
   directories.RecheckExclusive();
   // The release handle needs DELETE for the final same-handle rename.
   IntPtr raw=CreateFileW(slotPath,FileReadAttributes|IoReadControl|IoDeleteAccess,IoShareRead,IntPtr.Zero,OpenExisting,FileFlagBackupSemantics|FileFlagOpenReparsePoint,IntPtr.Zero);
   IoRequire(raw!=new IntPtr(-1));
   using(var slotHandle=new SafeFileHandle(raw,true)){
    var slotProof=JsProveSlot(slotHandle,slotPath,r,sid);
    IoRequire(Same(slotProof.fileId,request.SlotFileId)&&Same(slotProof.volumeId,request.SlotVolumeId));
    JsProveDirectory(directories.ParentHandle,r.Parent,r,sid);
    JsProveDirectory(directories.RootHandle,r.Root,r,sid);
    // A consumed attempt (immutable release-intent) or a failed revalidation
    // marker is never retried or reinterpreted.
    IoRequire(!JsSlotEntryExists(slotPath,"release-intent.json",r,sid));
    IoRequire(!JsSlotEntryExists(slotPath,"revalidation-failed.json",r,sid));
    var sources=new List<JsSource>();
    var workHandles=new List<SafeFileHandle>();
    var workStreams=new List<FileStream>();
    List<JsNamedEntry> files;
    try{
     // The release must reprove a live main source identity; sidecars may
     // legitimately be absent after the original recovery.
     for(int index=0;index<JsSuffixes.Length;index++)
      sources.Add(JsOpenSource(r,sid,JsSuffixes[index],index==0,profile));
     bool extra;
     files=JsInventorySlot(slotPath,r,sid,out extra);
     IoRequire(!extra);
     JsValidateLifecycle(slotPath,request,slotProof,files,sid);
     long total=0;foreach(var s in sources)if(s.Present)total=checked(total+s.Length);
     IoRequire(total<=profile.CombinedBytes);
     string fingerprint=JsFingerprint(request,request.Slot,slotProof.fileId,slotProof.volumeId,sources,files);
     IoRequire(Same(fingerprint,request.Fingerprint));
     // Only the fixed snapshot.sqlite{suffix} working names are disposed:
     // held DELETE handles, nlink1/private/non-reparse re-proof against the
     // inspected inventory, never a path unlink or recursive delete.
     foreach(var suffix in JsSuffixes){
      string name="snapshot.sqlite"+suffix;
      JsNamedEntry inspected=null;
      foreach(var f in files)if(f.Name==name)inspected=f;
      string workPath=IoChild(slotPath,name);
      IntPtr workRaw=CreateFileW(workPath,IoGenericRead|IoReadControl|IoDeleteAccess,IoShareRead,IntPtr.Zero,OpenExisting,FileFlagOpenReparsePoint,IntPtr.Zero);
      if(workRaw==new IntPtr(-1)){
       IoRequire(Marshal.GetLastWin32Error()==JsErrorFileNotFound&&inspected==null);
       continue;
      }
      var work=new SafeFileHandle(workRaw,true);
      workHandles.Add(work); // Own every acquired handle before comparisons.
      IoRequire(inspected!=null);
      {
       var proof=IoFileProof(work,workPath,r,sid,inspected.Length,inspected.FileId);
       IoRequire(Same(proof.volumeId,inspected.VolumeId)&&proof.linkCount==1);
       IoAclProof(work,sid,true);
       IoNtfsProof(work);
       var stream=new FileStream(work,FileAccess.Read,JsStreamBuffer,false);
       workStreams.Add(stream);
       IoRequire(JsStreamHash(stream,inspected.Length)==inspected.Sha256);
      }
     }
     // All disposable files are now held, hash checked, and deny mutation.
     // Recheck absence and current source bytes before the first mutation.
     JsRecheckSources(r,sid,sources);
     directories.RecheckExclusive();JsProveSlot(slotHandle,slotPath,r,sid,request.SlotFileId);
     var releaseIntent=new {version=1,operation="release",state="INTENT",path=r.Path,root=r.Root,profile=request.Profile,attemptId=r.AttemptId,slot=request.Slot,
      rootFileId=r.RootFileId,rootVolumeId=r.RootVolumeId,directoryFileId=r.DirectoryFileId,directoryVolumeId=r.DirectoryVolumeId,
      fileId=r.FileId,volumeId=r.VolumeId,slotFileId=slotProof.fileId,slotVolumeId=slotProof.volumeId,
      fingerprint,authorityFingerprint=request.AuthorityFingerprint,inspectionState=request.InspectionState,sources=JsStoredManifest(sources),
      files=files.ConvertAll(f=>(object)new{name=f.Name,fileId=f.FileId,volumeId=f.VolumeId,byteLength=f.Length,sha256=f.Sha256})};
     JsWriteNewFile(IoChild(slotPath,"release-intent.json"),JsonSerializer.SerializeToUtf8Bytes(releaseIntent),r,sid);
     foreach(var work in workHandles){
      IntPtr flag=Marshal.AllocHGlobal(1);
      try{Marshal.WriteByte(flag,1);IoRequire(IoSetFileInformation(work,JsFileDispositionInformation,flag,1));}
      finally{Marshal.FreeHGlobal(flag);}
     }
     foreach(var stream in workStreams)stream.Dispose();
     foreach(var work in workHandles)work.Dispose();
     foreach(var suffix in JsSuffixes){
      IntPtr gone=CreateFileW(IoChild(slotPath,"snapshot.sqlite"+suffix),IoGenericRead|IoReadControl,IoShareRead,IntPtr.Zero,OpenExisting,FileFlagOpenReparsePoint,IntPtr.Zero);
      int error=Marshal.GetLastWin32Error();
      if(gone!=new IntPtr(-1)){using(var unexpected=new SafeFileHandle(gone,true)){}IoRequire(false);}
      IoRequire(error==JsErrorFileNotFound);
     }
     directories.RecheckExclusive();
     JsProveSlot(slotHandle,slotPath,r,sid,request.SlotFileId);
     // The evidence-only slot becomes its attempt-bound archive name via the
     // same proven handle; never a create-or-open or overwrite rename.
     IoRequire(IoRenameNoReplace(slotHandle,archivePath,out int _));
     var archiveProof=JsProveSlot(slotHandle,archivePath,r,sid,request.SlotFileId);
     var receipt=new {version=1,operation="release",state="RELEASED",path=r.Path,root=r.Root,profile=request.Profile,attemptId=r.AttemptId,slot=request.Slot,
      slotFileId=archiveProof.fileId,slotVolumeId=archiveProof.volumeId,fingerprint=request.Fingerprint,authorityFingerprint=request.AuthorityFingerprint};
     JsWriteNewFile(IoChild(archivePath,"released.json"),JsonSerializer.SerializeToUtf8Bytes(receipt),r,sid);
     JsRecheckSources(r,sid,sources);
     directories.RecheckExclusive();
     return new JsOutcome {Status=0,Response=new {
      version=1,operation="release",state="RELEASED",path=r.Path,root=r.Root,profile=request.Profile,attemptId=r.AttemptId,slot=request.Slot,
      archive=archivePath,fingerprint=request.Fingerprint,
      directory=IoEvidence(directories.RecheckExclusive(),sid),slotDirectory=IoEvidence(archiveProof,sid)
     }};
    }
    finally{
     try{foreach(var stream in workStreams)stream.Dispose();}
     finally{try{foreach(var work in workHandles)work.Dispose();}finally{JsDisposeSources(sources);}}
    }
   }
  }
 }
 // Separate append-only evidence commit AFTER the release pipe has been
 // captured. It cannot delete, resend release, or overwrite a prior capture.
 static void JsValidateReleaseCapture(JsonElement capture,JsRequest request,string archivePath,FolioWindowsProbeResult archiveProof,string sid){
  IoRequest r=request.Common;
  JsKeys(capture,"request","response","stderr");
  IoRequire(JsCapturedBytes(capture,"stderr").Length==0);
  using var wireDoc=JsonDocument.Parse(JsCapturedBytes(capture,"request"));
  using var replyDoc=JsonDocument.Parse(JsCapturedBytes(capture,"response"));
  var wire=wireDoc.RootElement;var reply=replyDoc.RootElement;
  JsEnvelope(wire,request,"release");JsEnvelope(reply,request,"release","RELEASED");
  IoRequire(wire.GetProperty("slot").GetInt32()==request.Slot&&reply.GetProperty("slot").GetInt32()==request.Slot);
  IoRequire(Same(IoHex(wire.GetProperty("slotFileId"),32),archiveProof.fileId)&&Same(IoHex(wire.GetProperty("slotVolumeId"),16),archiveProof.volumeId));
  IoRequire(IoString(reply.GetProperty("archive"))==archivePath);
  JsCapturedProof(reply.GetProperty("slotDirectory"),archivePath,archiveProof.fileId,r,sid);
  JsCapturedProof(reply.GetProperty("directory"),r.Parent,r.DirectoryFileId,r,sid);
  using var intentDoc=JsonDocument.Parse(JsReadPrivate(IoChild(archivePath,"release-intent.json"),r,sid,JsMaxReceiptBytes));
  using var receiptDoc=JsonDocument.Parse(JsReadPrivate(IoChild(archivePath,"released.json"),r,sid,JsMaxReceiptBytes));
  var intent=intentDoc.RootElement;var receipt=receiptDoc.RootElement;
  JsEnvelope(intent,request,"release","INTENT");JsEnvelope(receipt,request,"release","RELEASED");
  foreach(var field in new[]{"rootFileId","rootVolumeId","directoryFileId","directoryVolumeId","fileId","volumeId","slotFileId","slotVolumeId","fingerprint","authorityFingerprint","inspectionState"})
   IoRequire(IoString(wire.GetProperty(field))==IoString(intent.GetProperty(field)));
  IoRequire(IoHex(reply.GetProperty("fingerprint"),64,true)==IoHex(intent.GetProperty("fingerprint"),64,true));
  IoRequire(IoString(receipt.GetProperty("fingerprint"))==IoString(intent.GetProperty("fingerprint")));
  IoRequire(Same(IoHex(receipt.GetProperty("slotFileId"),32),archiveProof.fileId)&&Same(IoHex(receipt.GetProperty("slotVolumeId"),16),archiveProof.volumeId));
  foreach(var suffix in JsSuffixes)IoRequire(!JsSlotEntryExists(archivePath,"snapshot.sqlite"+suffix,r,sid));
 }
 static JsOutcome JsCommitReleaseEvidence(JsRequest request,string sid,IoDirectoryLocks directories,ref bool attempted){
  IoRequest r=request.Common;attempted=true;
  string archivePath=IoCanonical(IoChild(r.Parent,JsArchivePrefix+r.AttemptId));
  using var admission=JsAcquireAdmission(directories.ParentHandle,r.Parent,r,sid,ref attempted);
  using var archive=JsOpenSlot(archivePath,r,sid,request.SlotFileId,out var proof);
  IoRequire(Same(proof.volumeId,request.SlotVolumeId));
  bool extra;var files=JsInventorySlot(archivePath,r,sid,out extra);IoRequire(!extra);
  JsValidateLifecycle(archivePath,request,proof,files,sid,true);
  JsValidateReleaseCapture(request.ReleaseCapture,request,archivePath,proof,sid);
  // This exact record includes byte lengths and hashes of the request and
  // both pipes. The same-handle write/flush/readback is the durable commit.
  JsWriteNewFile(IoChild(archivePath,"release-capture.json"),JsonSerializer.SerializeToUtf8Bytes(request.ReleaseCapture),r,sid);
  directories.RecheckExclusive();JsProveSlot(archive,archivePath,r,sid,request.SlotFileId);
  return new JsOutcome {Status=0,Response=new {
   version=1,operation="commit-release-evidence",state="EVIDENCE_COMMITTED",path=r.Path,root=r.Root,profile=request.Profile,attemptId=r.AttemptId,slot=request.Slot,
   archive=archivePath,directory=IoEvidence(directories.RecheckExclusive(),sid),slotDirectory=IoEvidence(proof,sid)
  }};
 }
 static int PrivateJournalSnapshotMode(){
  // Same captured-pipe invariant as the other private modes.
  if(!IoPipes()||GetFileType(GetStdHandle(-12))!=IoFileTypePipe){Console.Error.Write("WINDOWS_PRIVATE_IO_UNSAFE");return 1;}
  JsRequest request=null;
  bool attempted=false;
  bool outputAttempted=false;
  JsOutcome outcome=null;
  try{
   request=JsReadRequest();
   if(request.Common.Operation!="snapshot")attempted=true;
   using(var identity=WindowsIdentity.GetCurrent(TokenAccessLevels.Query)){
    string sid=identity.User.Value;
    using(var directories=new IoDirectoryLocks(request.Common,sid)){
     if(request.Common.Operation.StartsWith("capture-",StringComparison.Ordinal))outcome=JsCapture(request,sid,directories,ref attempted);
     else if(request.Common.Operation=="snapshot")outcome=JsSnapshot(request,sid,directories,ref attempted);
     else if(request.Common.Operation=="revalidate")outcome=JsRevalidate(request,sid,directories,ref attempted);
     else if(request.Common.Operation=="seal")outcome=JsSeal(request,sid,directories,ref attempted);
     else if(request.Common.Operation=="inspect")outcome=JsInspect(request,sid,directories,ref attempted);
     else if(request.Common.Operation=="commit-release-evidence")outcome=JsCommitReleaseEvidence(request,sid,directories,ref attempted);
     else outcome=JsRelease(request,sid,directories,ref attempted);
    }
   }
  }catch{
   if(request!=null){
    try{outcome=JsFailureOutcome(request,attempted?"UNKNOWN":"REJECTED",attempted?"PRIVATE_JOURNAL_SNAPSHOT_UNKNOWN":"PRIVATE_JOURNAL_SNAPSHOT_REJECTED");}catch{outcome=null;}
   }else outcome=null;
  }
  if(outcome==null){Console.Error.Write("WINDOWS_PRIVATE_IO_UNSAFE");return attempted||outputAttempted?3:1;}
  try{return IoOutput(outcome.Response,outcome.Status,ref outputAttempted,JsMaxOutputBytes);}
  catch{Console.Error.Write("WINDOWS_PRIVATE_IO_UNSAFE");return 3;}
 }
}
