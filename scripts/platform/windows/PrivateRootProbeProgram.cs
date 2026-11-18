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
internal static partial class PrivateRootProbeProgram {
 const int ErrorFileExists=unchecked((int)0x80070050);
 const int FileIdInfoClass=18;
 [StructLayout(LayoutKind.Sequential)]
 struct FILE_ID_128 { [MarshalAs(UnmanagedType.ByValArray,SizeConst=16)] public byte[] Identifier; }
 [StructLayout(LayoutKind.Sequential)]
 struct FILE_ID_INFO { public ulong VolumeSerialNumber; public FILE_ID_128 FileId; }
 [DllImport("kernel32.dll",SetLastError=true)]
 static extern bool GetFileInformationByHandleEx(IntPtr hFile,int infoClass,out FILE_ID_INFO info,uint size);
 const uint FileReadAttributes=0x00000080;
 const uint FileShareReadWrite=0x00000003;
 const uint OpenExisting=3;
 const uint FileFlagBackupSemantics=0x02000000;
 const uint FileFlagOpenReparsePoint=0x00200000;
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
 static extern IntPtr CreateFileW(string name,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
 static readonly string[] ReservedNames={"CON","PRN","AUX","NUL","CLOCK$","CONIN$","CONOUT$","COM1","COM2","COM3","COM4","COM5","COM6","COM7","COM8","COM9","LPT1","LPT2","LPT3","LPT4","LPT5","LPT6","LPT7","LPT8","LPT9"};
 static string Hex(byte[] bytes){return BitConverter.ToString(bytes).Replace("-","");}
 static void HandleIdentity(SafeHandle handle,out string fileId,out string volumeId){
  if(!GetFileInformationByHandleEx(handle.DangerousGetHandle(),FileIdInfoClass,out FILE_ID_INFO info,(uint)Marshal.SizeOf<FILE_ID_INFO>()))throw new IOException("FILE_ID_INFO");
  fileId=Hex(info.FileId.Identifier);
  volumeId=info.VolumeSerialNumber.ToString("X16");
 }
 static bool Same(string left,string right){return string.Equals(left,right,StringComparison.OrdinalIgnoreCase);}
 static string Serialize(FolioWindowsProbeResult p,string state,string handleFileId,string handleVolumeId){
  return JsonSerializer.Serialize(new {canonicalPath=p.canonicalPath,canonicalRoot=p.canonicalRoot,daclPrivate=p.daclPrivate,fileId=p.fileId,handleFileId,handleVolumeId,linkCount=p.linkCount,localFilesystem=p.localFilesystem,ownerSid=p.ownerSid,platform="win32",reparsePoint=p.reparsePoint,rootFileId=p.rootFileId,rootVolumeId=p.rootVolumeId,sid=p.ownerSid,state,volumeId=p.volumeId});
 }
 static int Uncertain(string path,string reason){
  Console.Write(JsonSerializer.Serialize(new {path,reason,state="UNKNOWN"}));
  return 3;
 }
 static int Probe(string[] args,string sid){
  var p=FolioWindowsProbe.Run(args[0],args[1],sid);
  Console.Write(JsonSerializer.Serialize(new {canonicalPath=p.canonicalPath,canonicalRoot=p.canonicalRoot,daclPrivate=p.daclPrivate,fileId=p.fileId,linkCount=p.linkCount,localFilesystem=p.localFilesystem,ownerSid=p.ownerSid,platform="win32",reparsePoint=p.reparsePoint,rootFileId=p.rootFileId,rootVolumeId=p.rootVolumeId,sid=sid,volumeId=p.volumeId}));
  return 0;
 }
 static void ValidateTarget(string path,string root,string sid){
  if(path.StartsWith("\\\\",StringComparison.Ordinal)||path.IndexOf(':')!=1||path.IndexOf(':',2)>=0)throw new InvalidOperationException();
  FolioWindowsProbe.Run(root,root,sid);
  string directory=Path.GetDirectoryName(path);
  if(directory==null||directory.Length==0)throw new InvalidOperationException();
  FolioWindowsProbe.Run(directory,root,sid);
  string name=Path.GetFileName(path);
  if(name.Length==0||name=="."||name=="..")throw new InvalidOperationException();
 }
 static void AssertRoot(FolioWindowsProbeResult root,FolioWindowsProbeResult p){
  if(root.rootFileId!=p.rootFileId||root.volumeId!=p.rootVolumeId||root.canonicalRoot!=p.canonicalRoot)throw new InvalidOperationException();
 }
 // A create that may have published a file whose durability is unconfirmed is
 // reported as UNKNOWN. The path is retained for a later explicit open.
 static int Create(string[] args,string sid){
  ValidateTarget(args[0],args[1],sid);
  string handleFileId;
  string handleVolumeId;
  try{
   using(var stream=new FileStream(args[0],FileMode.CreateNew,FileAccess.ReadWrite,FileShare.None,4096,FileOptions.WriteThrough)){
    stream.Flush(true);
    if(stream.Length!=0)throw new InvalidOperationException();
    HandleIdentity(stream.SafeFileHandle,out handleFileId,out handleVolumeId);
    stream.Flush(true);
   }
  }catch(IOException error) when(error.HResult==ErrorFileExists){
   return Uncertain(args[0],"EXISTS");
  }catch(Exception){
   return Uncertain(args[0],"CREATE_UNCONFIRMED");
  }
  var root=FolioWindowsProbe.Run(args[1],args[1],sid);
  var p=FolioWindowsProbe.Run(args[0],args[1],sid);
  try{AssertRoot(root,p);}catch{return Uncertain(args[0],"ROOT_CHANGED");}
  if(!Same(handleFileId,p.fileId)||!Same(handleVolumeId,p.volumeId))return Uncertain(args[0],"IDENTITY_CHANGED");
  Console.Write(Serialize(p,"CREATED",handleFileId,handleVolumeId));
  return 0;
 }
 // Explicit reopen of an existing ledger: durable flush plus handle identity
 // readback; this is not a resend of the original credential write.
 static int Open(string[] args,string sid){
  ValidateTarget(args[0],args[1],sid);
  string handleFileId;
  string handleVolumeId;
  try{
   using(var stream=new FileStream(args[0],FileMode.Open,FileAccess.ReadWrite,FileShare.ReadWrite,4096,FileOptions.WriteThrough)){
    stream.Flush(true);
    HandleIdentity(stream.SafeFileHandle,out handleFileId,out handleVolumeId);
    stream.Flush(true);
   }
  }catch(Exception){
   return Uncertain(args[0],"OPEN_UNCONFIRMED");
  }
  var root=FolioWindowsProbe.Run(args[1],args[1],sid);
  var p=FolioWindowsProbe.Run(args[0],args[1],sid);
  try{AssertRoot(root,p);}catch{return Uncertain(args[0],"ROOT_CHANGED");}
  if(!Same(handleFileId,p.fileId)||!Same(handleVolumeId,p.volumeId))return Uncertain(args[0],"IDENTITY_CHANGED");
  Console.Write(Serialize(p,"OPEN",handleFileId,handleVolumeId));
  return 0;
 }
 static void ValidateDirectorySegment(string segment){
  if(segment.Length==0||segment=="."||segment=="..")throw new InvalidOperationException();
  foreach(char c in segment){if(c<0x20||c==0x7f||"<>:\"|?*".IndexOf(c)>=0)throw new InvalidOperationException();}
  if(segment.EndsWith(" ",StringComparison.Ordinal)||segment.EndsWith(".",StringComparison.Ordinal))throw new InvalidOperationException();
  if(System.Text.RegularExpressions.Regex.IsMatch(segment,"~\\d"))throw new InvalidOperationException();
  string stem=segment.Split('.')[0].ToUpperInvariant();
  if(Array.IndexOf(ReservedNames,stem)>=0)throw new InvalidOperationException();
 }
 static string[] ParseDirectorySegments(string path){
  if(path==null||path.StartsWith("\\\\",StringComparison.Ordinal)||path.StartsWith("//",StringComparison.Ordinal))throw new InvalidOperationException();
  if(path.Length<3||path[1]!=':'||!char.IsLetter(path[0]))throw new InvalidOperationException();
  if(path[2]!='\\'&&path[2]!='/')throw new InvalidOperationException();
  string rest=path.Substring(3);
  if(rest.Length==0)return new string[0];
  string[] segments=rest.Split(new[]{'\\','/'});
  foreach(string segment in segments)ValidateDirectorySegment(segment);
  return segments;
 }
 static string CanonicalDirectory(string path){
  string[] segments=ParseDirectorySegments(path);
  return char.ToUpperInvariant(path[0])+":\\"+string.Join("\\",segments);
 }
 static string[] RelativeDirectorySegments(string path,string root){
  string[] target=ParseDirectorySegments(path);
  string[] baseline=ParseDirectorySegments(root);
  if(char.ToUpperInvariant(path[0])!=char.ToUpperInvariant(root[0]))throw new InvalidOperationException();
  if(target.Length<=baseline.Length)throw new InvalidOperationException();
  for(int i=0;i<baseline.Length;i++)if(!Same(target[i],baseline[i]))throw new InvalidOperationException();
  var relative=new string[target.Length-baseline.Length];
  Array.Copy(target,baseline.Length,relative,0,relative.Length);
  return relative;
 }
 static SafeFileHandle OpenDirectoryHandle(string path){
  IntPtr handle=CreateFileW(path,FileReadAttributes,FileShareReadWrite,IntPtr.Zero,OpenExisting,FileFlagBackupSemantics|FileFlagOpenReparsePoint,IntPtr.Zero);
  if(handle==new IntPtr(-1))throw new IOException("OPEN_DIRECTORY");
  return new SafeFileHandle(handle,true);
 }
 static int DirectoryFailure(bool created,string path,string reason){
  if(created)return Uncertain(path,reason);
  throw new InvalidOperationException();
 }
 // Directory mode creates only missing descendants of an already-existing
 // private root. Every ancestor handle is opened without DELETE sharing and
 // held until the final target proof, so an ancestor cannot be renamed or
 // reparse-swapped during creation. A failure after any creation is UNKNOWN;
 // nothing is recursively deleted.
 static int DirectoryMode(string[] args,string sid){
  string root=CanonicalDirectory(args[1]);
  string target=CanonicalDirectory(args[0]);
  string[] relative=RelativeDirectorySegments(args[0],args[1]);
  var handles=new List<SafeFileHandle>();
  bool created=false;
  try{
   SafeFileHandle rootHandle=OpenDirectoryHandle(root);
   handles.Add(rootHandle);
   FolioWindowsProbeResult rootBefore=FolioWindowsProbe.Run(root,root,sid);
   string current=root;
   SafeFileHandle last=rootHandle;
   foreach(string segment in relative){
    string child=current+"\\"+segment;
    SafeFileHandle handle;
    try{
     handle=OpenDirectoryHandle(child);
    }catch(IOException){
     try{
      System.IO.Directory.CreateDirectory(child);
     }catch(Exception){
      return DirectoryFailure(created,target,"DIRECTORY_UNCONFIRMED");
     }
     created=true;
     try{
      handle=OpenDirectoryHandle(child);
     }catch(Exception){
      return DirectoryFailure(true,target,"DIRECTORY_UNCONFIRMED");
     }
    }
    handles.Add(handle);
    var childProbe=FolioWindowsProbe.Run(child,root,sid);
    AssertRoot(rootBefore,childProbe);
    if(!Same(childProbe.canonicalPath,child))return DirectoryFailure(created,target,"CANONICAL_CHANGED");
    last=handle;
    current=child;
   }
   var rootAfter=FolioWindowsProbe.Run(root,root,sid);
   if(!Same(rootAfter.rootFileId,rootBefore.rootFileId)||!Same(rootAfter.volumeId,rootBefore.volumeId)||!Same(rootAfter.canonicalRoot,rootBefore.canonicalRoot))
    return DirectoryFailure(created,target,"ROOT_CHANGED");
   var finalProbe=FolioWindowsProbe.Run(target,root,sid);
   AssertRoot(rootAfter,finalProbe);
   if(!Same(finalProbe.canonicalPath,target))return DirectoryFailure(created,target,"CANONICAL_CHANGED");
   string handleFileId;
   string handleVolumeId;
   HandleIdentity(last,out handleFileId,out handleVolumeId);
   if(!Same(handleFileId,finalProbe.fileId)||!Same(handleVolumeId,finalProbe.volumeId))
    return DirectoryFailure(created,target,"IDENTITY_CHANGED");
   Console.Write(Serialize(finalProbe,created?"CREATED":"OPEN",handleFileId,handleVolumeId));
   return 0;
  }catch{
   if(created)return Uncertain(target,"DIRECTORY_UNCONFIRMED");
   throw;
  }finally{
   foreach(var handle in handles)handle.Dispose();
  }
 }
 // Private I/O v1 is deliberately separate from the historical modes above.
 // It proves exclusive visibility and flushed CONTENTS, never crash-durable
 // namespace publication. No failure authorizes cleanup or a second attempt.
 const int PrivateIoMaxBytes=1048576;
 const int PrivateIoV2MaxReadBytes=256*1024*1024;
 const int PrivateIoV2MaxReadOutputBytes=4*((PrivateIoV2MaxReadBytes+2)/3)+32768;
 const int PrivateIoMaxStdinBytes=1500000;
 const int PrivateIoMaxOutputBytes=1500000;
 const uint IoReadControl=0x00020000;
 const uint IoGenericRead=0x80000000;
 const uint IoGenericWrite=0x40000000;
 const uint IoDeleteAccess=0x00010000;
 const uint IoShareRead=0x00000001;
 const uint IoCreateNew=1;
 const uint IoWriteThrough=0x80000000;
 const int IoFileRenameInfo=3;
 const uint IoFileTypePipe=3;
 const int IoStdInputHandle=-10;
 const int IoStdOutputHandle=-11;
 [StructLayout(LayoutKind.Sequential)]
 struct IO_STANDARD_INFO {
  public long AllocationSize;
  public long EndOfFile;
  public uint NumberOfLinks;
  [MarshalAs(UnmanagedType.U1)] public bool DeletePending;
  [MarshalAs(UnmanagedType.U1)] public bool Directory;
 }
 [StructLayout(LayoutKind.Sequential)]
 struct IO_TAG_INFO { public uint FileAttributes; public uint ReparseTag; }
 [StructLayout(LayoutKind.Sequential)]
 struct IO_SECURITY_ATTRIBUTES {
  public uint Length;
  public IntPtr SecurityDescriptor;
  [MarshalAs(UnmanagedType.Bool)] public bool InheritHandle;
 }
 // Offsets must be obtained from the ABI, not assumed from an x64 example.
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]
 struct IO_RENAME_INFO {
  [MarshalAs(UnmanagedType.U1)] public bool ReplaceIfExists;
  public IntPtr RootDirectory;
  public uint FileNameLength;
  [MarshalAs(UnmanagedType.U2)] public char FileName;
 }
 [DllImport("kernel32.dll",EntryPoint="GetFileInformationByHandleEx",SetLastError=true)]
 static extern bool IoGetStandard(SafeFileHandle handle,int infoClass,out IO_STANDARD_INFO info,uint size);
 [DllImport("kernel32.dll",EntryPoint="GetFileInformationByHandleEx",SetLastError=true)]
 static extern bool IoGetTag(SafeFileHandle handle,int infoClass,out IO_TAG_INFO info,uint size);
 [DllImport("kernel32.dll",EntryPoint="CreateFileW",CharSet=CharSet.Unicode,SetLastError=true)]
 static extern SafeFileHandle IoCreateFile(string name,uint access,uint share,ref IO_SECURITY_ATTRIBUTES security,uint disposition,uint flags,IntPtr template);
 [DllImport("kernel32.dll",EntryPoint="SetFileInformationByHandle",SetLastError=true)]
 static extern bool IoSetFileInformation(SafeFileHandle handle,int infoClass,IntPtr info,uint size);
 [DllImport("advapi32.dll",EntryPoint="ConvertStringSecurityDescriptorToSecurityDescriptorW",CharSet=CharSet.Unicode,SetLastError=true)]
 static extern bool IoConvertSecurityDescriptor(string text,uint revision,out IntPtr descriptor,out uint size);
 [DllImport("kernel32.dll",EntryPoint="LocalFree")]
 static extern IntPtr IoLocalFree(IntPtr memory);
 [DllImport("kernel32.dll")]
 static extern IntPtr GetStdHandle(int standardHandle);
 [DllImport("kernel32.dll",SetLastError=true)]
 static extern uint GetFileType(IntPtr handle);

 sealed class IoRequest {
  public string Operation="";
  public string Path="";
  public string Root="";
  public string RootFileId="";
  public string RootVolumeId="";
  public string DirectoryFileId="";
  public string DirectoryVolumeId="";
  public string Parent="";
  public string AttemptId="";
  public string StagingPath="";
  public string BytesBase64="";
  public string FileId="";
  public string VolumeId="";
  public string ExpectedSha256="";
  public int MaxBytes;
 }
 static void IoRequire(bool condition){if(!condition)throw new InvalidOperationException("PRIVATE_IO_UNSAFE");}
 static bool IoPipes(){
  return OperatingSystem.IsWindows()&&
   GetFileType(GetStdHandle(IoStdInputHandle))==IoFileTypePipe&&
   GetFileType(GetStdHandle(IoStdOutputHandle))==IoFileTypePipe;
 }
 static string IoCanonical(string path){
  IoRequire(path!=null&&path.Length>=3&&path.Length<=240);
  foreach(char c in path)IoRequire(c>=0x20&&c<=0x7e);
  IoRequire(CanonicalDirectory(path)==path);
  return path;
 }
 static string IoChild(string parent,string name){return parent+(parent.EndsWith("\\",StringComparison.Ordinal)?"":"\\")+name;}
 static string IoString(JsonElement value){
  IoRequire(value.ValueKind==JsonValueKind.String);
  string result=value.GetString();
  IoRequire(result!=null);
  return result;
 }
 static string IoHex(JsonElement value,int length,bool lowerOnly=false){
  string result=IoString(value);
  IoRequire(result.Length==length);
  foreach(char c in result)IoRequire((c>='0'&&c<='9')||(c>='a'&&c<='f')||(!lowerOnly&&c>='A'&&c<='F'));
  return result;
 }
 static int IoInteger(JsonElement value){
  IoRequire(value.ValueKind==JsonValueKind.Number&&value.TryGetInt32(out _));
  return value.GetInt32();
 }
 static IoRequest IoReadRequest(){
  // Stop at max+1, never ReadToEnd. Parse only after pipe EOF.
  using var input=Console.OpenStandardInput();
  using var buffer=new MemoryStream();
  byte[] chunk=new byte[8192];
  for(;;){
   int remaining=PrivateIoMaxStdinBytes+1-(int)buffer.Length;
   int count=input.Read(chunk,0,Math.Min(chunk.Length,remaining));
   if(count==0)break;
   buffer.Write(chunk,0,count);
   IoRequire(buffer.Length<=PrivateIoMaxStdinBytes);
  }
  byte[] encoded=buffer.ToArray();
  IoRequire(encoded.Length>0&&!(encoded.Length>=3&&encoded[0]==0xef&&encoded[1]==0xbb&&encoded[2]==0xbf));
  string json=new System.Text.UTF8Encoding(false,true).GetString(encoded);
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
  IoRequire(operation=="publish-new"||operation=="read-private");
  var names=new HashSet<string>(new[]{"version","operation","path","root","rootFileId","rootVolumeId","directoryFileId","directoryVolumeId"},StringComparer.Ordinal);
  if(operation=="publish-new")names.UnionWith(new[]{"attemptId","bytesBase64"});
  else names.UnionWith(new[]{"fileId","volumeId","expectedSha256","maxBytes"});
  IoRequire(fields.Count==names.Count);
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
  if(operation=="publish-new"){
   r.AttemptId=IoHex(fields["attemptId"],32,true);
   r.StagingPath=IoCanonical(IoChild(r.Parent,".folio-private-"+r.AttemptId+".tmp"));
   RelativeDirectorySegments(r.StagingPath,r.Root);
   IoRequire(!Same(r.Path,r.StagingPath));
   r.BytesBase64=IoString(fields["bytesBase64"]);
   IoRequire(r.BytesBase64.Length<=4*((PrivateIoMaxBytes+2)/3));
  }else{
   r.FileId=IoHex(fields["fileId"],32);
   r.VolumeId=IoHex(fields["volumeId"],16);
   r.ExpectedSha256=IoHex(fields["expectedSha256"],64,true);
   r.MaxBytes=IoInteger(fields["maxBytes"]);
   IoRequire(r.MaxBytes>=0&&r.MaxBytes<=PrivateIoMaxBytes&&Same(r.VolumeId,r.RootVolumeId));
  }
  return r;
 }
 static IO_STANDARD_INFO IoInspect(SafeFileHandle handle,bool directory){
  IoRequire(!handle.IsInvalid&&!handle.IsClosed&&GetFileType(handle.DangerousGetHandle())==1);
  IoRequire(IoGetTag(handle,9,out IO_TAG_INFO tag,(uint)Marshal.SizeOf<IO_TAG_INFO>()));
  IoRequire((tag.FileAttributes&0x400)==0&&tag.ReparseTag==0);
  IoRequire(IoGetStandard(handle,1,out IO_STANDARD_INFO info,(uint)Marshal.SizeOf<IO_STANDARD_INFO>()));
  IoRequire(info.Directory==directory&&!info.DeletePending);
  if(!directory)IoRequire(info.NumberOfLinks==1&&info.EndOfFile>=0);
  return info;
 }
 static FolioWindowsProbeResult IoProof(SafeFileHandle handle,string path,IoRequest r,string sid){
  var p=FolioWindowsProbe.Run(path,r.Root,sid);
  HandleIdentity(handle,out string id,out string volume);
  IoRequire(Same(p.canonicalPath,path)&&Same(p.canonicalRoot,r.Root)&&p.daclPrivate&&!p.reparsePoint&&p.localFilesystem&&p.linkCount==1);
  IoRequire(p.ownerSid==sid&&Same(id,p.fileId)&&Same(volume,p.volumeId));
  IoRequire(Same(volume,r.RootVolumeId)&&Same(p.rootFileId,r.RootFileId)&&Same(p.rootVolumeId,r.RootVolumeId));
  return p;
 }
 sealed class IoDirectoryPin {
  public string Path;
  public SafeFileHandle Handle;
  public string FileId;
  public string VolumeId;
  public bool Private;
  public IoDirectoryPin(string path,SafeFileHandle handle,bool isPrivate){
   Path=path;Handle=handle;Private=isPrivate;
   HandleIdentity(handle,out FileId,out VolumeId);
  }
 }
 sealed class IoDirectoryLocks:IDisposable {
  readonly List<IoDirectoryPin> pins=new List<IoDirectoryPin>();
  readonly IoRequest request;
  readonly string sid;
  public IoDirectoryLocks(IoRequest r,string currentSid){
   request=r;sid=currentSid;
   try{
    string current=r.Parent.Substring(0,3);
    bool isPrivate=false;
    Lock(current,ref isPrivate);
    foreach(string segment in ParseDirectorySegments(r.Parent)){
     current=IoChild(current,segment);
     Lock(current,ref isPrivate);
    }
    IoRequire(isPrivate);
    Recheck();
   }catch{Dispose();throw;}
  }
  void Lock(string path,ref bool isPrivate){
   // Unlike historical directory mode: deny BOTH write and delete sharing,
   // from the drive root through the parent, and keep every pin to the end.
   IntPtr raw=CreateFileW(path,FileReadAttributes|IoReadControl,IoShareRead,IntPtr.Zero,OpenExisting,FileFlagBackupSemantics|FileFlagOpenReparsePoint,IntPtr.Zero);
   IoRequire(raw!=new IntPtr(-1));
   var handle=new SafeFileHandle(raw,true);
   try{
    IoInspect(handle,true);
    if(Same(path,request.Root))isPrivate=true;
    var pin=new IoDirectoryPin(path,handle,isPrivate);
    pins.Add(pin);
   }catch{handle.Dispose();throw;}
   Check(pins[pins.Count-1]);
  }
  FolioWindowsProbeResult Check(IoDirectoryPin pin){
   IoInspect(pin.Handle,true);
   HandleIdentity(pin.Handle,out string id,out string volume);
   IoRequire(Same(id,pin.FileId)&&Same(volume,pin.VolumeId));
   if(!pin.Private)return null;
   var p=IoProof(pin.Handle,pin.Path,request,sid);
   if(Same(pin.Path,request.Root))IoRequire(Same(p.fileId,request.RootFileId));
   if(Same(pin.Path,request.Parent))IoRequire(Same(p.fileId,request.DirectoryFileId)&&Same(p.volumeId,request.DirectoryVolumeId));
   return p;
  }
  public FolioWindowsProbeResult Recheck(){
   FolioWindowsProbeResult parent=null;
   foreach(var pin in pins){
    var proof=Check(pin);
    if(Same(pin.Path,request.Parent))parent=proof;
   }
   IoRequire(parent!=null);
   return parent;
  }
  // Exclusive-create additions: the already-held ancestor handles, never a
  // reopened path. NtCreateFile creates relative to ParentHandle.
  IoDirectoryPin PinFor(string path){
   foreach(var pin in pins)if(Same(pin.Path,path))return pin;
   throw new InvalidOperationException();
  }
  public SafeFileHandle RootHandle {get{return PinFor(request.Root).Handle;}}
  public SafeFileHandle ParentHandle {get{return PinFor(request.Parent).Handle;}}
  public FolioWindowsProbeResult RootEvidence(){return IoProof(RootHandle,request.Root,request,sid);}
  // Every held ancestor is re-inspected on its own handle: no reparse/delete,
  // local NTFS volume, unchanged File ID on the expected root volume; the
  // private root-through-parent pins also prove owner+DACL. Recheck() then
  // applies the existing identity/proof walk unchanged.
  public FolioWindowsProbeResult RecheckExclusive(){
   foreach(var pin in pins){
    IoInspect(pin.Handle,true);
    IoNtfsProof(pin.Handle);
    HandleIdentity(pin.Handle,out string id,out string volume);
    IoRequire(Same(id,pin.FileId)&&Same(volume,pin.VolumeId)&&Same(volume,request.RootVolumeId));
    if(pin.Private)IoAclProof(pin.Handle,sid,false);
   }
   return Recheck();
  }
  public void Dispose(){foreach(var pin in pins)pin.Handle.Dispose();}
 }
 static object IoEvidence(FolioWindowsProbeResult p,string sid){
  return new {canonicalPath=p.canonicalPath,canonicalRoot=p.canonicalRoot,daclPrivate=p.daclPrivate,fileId=p.fileId,linkCount=p.linkCount,localFilesystem=p.localFilesystem,ownerSid=p.ownerSid,platform="win32",reparsePoint=p.reparsePoint,rootFileId=p.rootFileId,rootVolumeId=p.rootVolumeId,sid,volumeId=p.volumeId};
 }
 static int IoOutput(object response,int status,ref bool outputAttempted,int maximum=PrivateIoMaxOutputBytes){
  IoRequire(IoPipes());
  // This is a captured JSON pipe, never HTML. Keep base64 '+' unescaped so
  // the 1 MiB payload has the same bounded representation in both directions.
  byte[] bytes=JsonSerializer.SerializeToUtf8Bytes(response,new JsonSerializerOptions {
   Encoder=System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping
  });
  IoRequire(bytes.Length<=maximum);
  outputAttempted=true;
  using var output=Console.OpenStandardOutput();
  output.Write(bytes,0,bytes.Length);
  output.Flush();
  return status;
 }
 static int IoFailure(IoRequest r,string state,ref bool outputAttempted){
  string reason=state=="EXISTS"?"PRIVATE_IO_EXISTS":state=="UNKNOWN"?"PRIVATE_IO_UNKNOWN":"PRIVATE_IO_REJECTED";
  int status=state=="EXISTS"?2:state=="UNKNOWN"?3:1;
  if(r.Operation=="publish-new")
   return IoOutput(new {version=1,operation=r.Operation,path=r.Path,root=r.Root,attemptId=r.AttemptId,stagingPath=r.StagingPath,state,reason},status,ref outputAttempted);
  return IoOutput(new {version=1,operation=r.Operation,path=r.Path,root=r.Root,state,reason},status,ref outputAttempted);
 }
 static byte[] IoReadExact(FileStream stream,int length,int maximum=PrivateIoMaxBytes){
  IoRequire(length>=0&&length<=maximum);
  stream.Position=0;
  byte[] bytes=new byte[length];
  int offset=0;
  while(offset<length){
   int count=stream.Read(bytes,offset,length-offset);
   IoRequire(count>0);
   offset+=count;
  }
  IoRequire(stream.ReadByte()==-1&&stream.Length==length);
  return bytes;
 }
 static string IoSha256(byte[] bytes){
  return Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant();
 }
 static FolioWindowsProbeResult IoFileProof(SafeFileHandle handle,string path,IoRequest r,string sid,long length,string expectedId){
  var standard=IoInspect(handle,false);
  IoRequire(standard.EndOfFile==length);
  var proof=IoProof(handle,path,r,sid);
  if(expectedId!=null)IoRequire(Same(proof.fileId,expectedId));
  return proof;
 }
 static bool IoRenameNoReplace(SafeFileHandle handle,string destination,out int error){
  byte[] name=System.Text.Encoding.Unicode.GetBytes(destination);
  int replaceOffset=Marshal.OffsetOf<IO_RENAME_INFO>(nameof(IO_RENAME_INFO.ReplaceIfExists)).ToInt32();
  int rootOffset=Marshal.OffsetOf<IO_RENAME_INFO>(nameof(IO_RENAME_INFO.RootDirectory)).ToInt32();
  int lengthOffset=Marshal.OffsetOf<IO_RENAME_INFO>(nameof(IO_RENAME_INFO.FileNameLength)).ToInt32();
  int nameOffset=Marshal.OffsetOf<IO_RENAME_INFO>(nameof(IO_RENAME_INFO.FileName)).ToInt32();
  int size=checked(nameOffset+name.Length);
  IntPtr buffer=Marshal.AllocHGlobal(size);
  try{
   Marshal.Copy(new byte[size],0,buffer,size);
   Marshal.WriteByte(buffer,replaceOffset,0); // ReplaceIfExists=false (BOOLEAN).
   Marshal.WriteIntPtr(buffer,rootOffset,IntPtr.Zero); // Full canonical name.
   Marshal.WriteInt32(buffer,lengthOffset,name.Length);
   Marshal.Copy(name,0,IntPtr.Add(buffer,nameOffset),name.Length);
   bool renamed=IoSetFileInformation(handle,IoFileRenameInfo,buffer,(uint)size);
   error=renamed?0:Marshal.GetLastWin32Error();
   return renamed;
  }finally{Marshal.FreeHGlobal(buffer);}
 }
 static int IoPublish(IoRequest r,string sid,IoDirectoryLocks directories,ref bool attempted,ref bool outputAttempted){
  // Root and parent handle identities have already been bound. Payload decode
  // is canonical and bounded, and no existing staging name is ever reopened.
  byte[] payload=Convert.FromBase64String(r.BytesBase64);
  IoRequire(payload.Length<=PrivateIoMaxBytes&&Convert.ToBase64String(payload)==r.BytesBase64);
  IntPtr descriptor=IntPtr.Zero;
  SafeFileHandle stage;
  try{
   string sddl="O:"+sid+"G:"+sid+"D:P(A;;FA;;;"+sid+")";
   IoRequire(IoConvertSecurityDescriptor(sddl,1,out descriptor,out _));
   var attributes=new IO_SECURITY_ATTRIBUTES {Length=(uint)Marshal.SizeOf<IO_SECURITY_ATTRIBUTES>(),SecurityDescriptor=descriptor,InheritHandle=false};
   attempted=true; // Even an unsuccessful CREATE_NEW call is conservatively UNKNOWN.
   stage=IoCreateFile(r.StagingPath,IoGenericRead|IoGenericWrite|IoDeleteAccess|IoReadControl,IoShareRead,ref attributes,IoCreateNew,FileFlagOpenReparsePoint|IoWriteThrough,IntPtr.Zero);
  }finally{if(descriptor!=IntPtr.Zero)IoLocalFree(descriptor);}
  using(stage){
   IoRequire(!stage.IsInvalid);
   var stagingProof=IoFileProof(stage,r.StagingPath,r,sid,0,null);
   using(var stream=new FileStream(stage,FileAccess.ReadWrite,4096,false)){
    stream.Write(payload,0,payload.Length);
    stream.Flush(true);
    IoRequire(System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(payload,IoReadExact(stream,payload.Length)));
    IoFileProof(stage,r.StagingPath,r,sid,payload.Length,stagingProof.fileId);
    stream.Flush(true);
    if(!IoRenameNoReplace(stage,r.Path,out int error)){
     directories.Recheck();
     return IoFailure(r,error==80||error==183?"EXISTS":"UNKNOWN",ref outputAttempted);
    }
    stream.Flush(true);
    IoRequire(System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(payload,IoReadExact(stream,payload.Length)));
    var file=IoFileProof(stage,r.Path,r,sid,payload.Length,stagingProof.fileId);
    var directory=directories.Recheck();
    return IoOutput(new {
     version=1,operation=r.Operation,path=r.Path,root=r.Root,attemptId=r.AttemptId,stagingPath=r.StagingPath,state="PUBLISHED",
     file=IoEvidence(file,sid),directory=IoEvidence(directory,sid),byteLength=payload.Length,sha256=IoSha256(payload),
     contentFlushed=true,@namespace="EXCLUSIVE_NO_REPLACE",namespaceDurability="UNPROVEN"
    },0,ref outputAttempted);
   }
  }
 }
 static int IoReadPrivate(IoRequest r,string sid,IoDirectoryLocks directories,ref bool outputAttempted){
  IntPtr raw=CreateFileW(r.Path,IoGenericRead|IoReadControl,IoShareRead,IntPtr.Zero,OpenExisting,FileFlagOpenReparsePoint,IntPtr.Zero);
  IoRequire(raw!=new IntPtr(-1));
  using(var handle=new SafeFileHandle(raw,true)){
   var standard=IoInspect(handle,false);
   IoRequire(standard.EndOfFile<=r.MaxBytes&&standard.EndOfFile<=PrivateIoMaxBytes);
   int length=checked((int)standard.EndOfFile);
   IoFileProof(handle,r.Path,r,sid,length,r.FileId); // Before any file bytes.
   using(var stream=new FileStream(handle,FileAccess.Read,4096,false)){
    byte[] bytes=IoReadExact(stream,length);
    string sha256=IoSha256(bytes);
    IoRequire(System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(Convert.FromHexString(sha256),Convert.FromHexString(r.ExpectedSha256)));
    var file=IoFileProof(handle,r.Path,r,sid,length,r.FileId);
    var directory=directories.Recheck();
    // Private bytes go ONLY to the guarded captured pipe, never diagnostics.
    return IoOutput(new {version=1,operation=r.Operation,path=r.Path,root=r.Root,state="READ",
     file=IoEvidence(file,sid),directory=IoEvidence(directory,sid),bytesBase64=Convert.ToBase64String(bytes),byteLength=length,sha256
    },0,ref outputAttempted);
   }
  }
 }
 static int PrivateIoMode(){
  // A redirected regular file is NOT safe: both standard handles must be pipes.
  if(!IoPipes()){Console.Error.Write("WINDOWS_PRIVATE_IO_UNSAFE");return 1;}
  IoRequest request=null;
  bool attempted=false;
  bool outputAttempted=false;
  try{
   request=IoReadRequest();
   using(var identity=WindowsIdentity.GetCurrent()){
    string sid=identity.User.Value;
    using(var directories=new IoDirectoryLocks(request,sid)){
     if(request.Operation=="publish-new")return IoPublish(request,sid,directories,ref attempted,ref outputAttempted);
     return IoReadPrivate(request,sid,directories,ref outputAttempted);
    }
   }
  }catch{
   if(request!=null&&!outputAttempted){
    try{return IoFailure(request,attempted?"UNKNOWN":"REJECTED",ref outputAttempted);}catch{}
   }
   Console.Error.Write("WINDOWS_PRIVATE_IO_UNSAFE");
   return attempted||outputAttempted?3:1;
  }
 }
 // Private I/O v2 is a two-phase NTFS-bound publication contract layered on
 // the same locked-ancestor, same-handle proof and captured-pipe primitives.
 // It additionally proves, on the SAME open handle, a local NTFS volume and a
 // private owner+DACL. Mode methods return assembled outcomes; the terminal
 // output is emitted only after every owned handle scope has disposed.
 sealed class IoV2Request {
  public IoRequest Common;
  public long ByteLength;
  public bool HasExpectedSha256;
 }
 sealed class IoV2Outcome {
  public object Response;
  public int Status;
 }
 [StructLayout(LayoutKind.Sequential)]
 struct IO_STATUS_BLOCK { public IntPtr Status; public UIntPtr Information; }
 [StructLayout(LayoutKind.Sequential)]
 struct IO_FS_DEVICE_INFORMATION { public uint DeviceType; public uint Characteristics; }
 [DllImport("kernel32.dll",EntryPoint="GetVolumeInformationByHandleW",CharSet=CharSet.Unicode,SetLastError=true)]
 static extern bool IoGetVolumeInformation(SafeFileHandle handle,IntPtr volumeName,uint volumeNameSize,IntPtr serial,IntPtr maximumComponent,out uint fileSystemFlags,System.Text.StringBuilder fileSystemName,uint fileSystemNameSize);
 [DllImport("ntdll.dll",EntryPoint="NtQueryVolumeInformationFile")]
 static extern int IoQueryVolumeInformation(SafeFileHandle handle,out IO_STATUS_BLOCK statusBlock,IntPtr information,uint length,int informationClass);
 [DllImport("advapi32.dll",EntryPoint="GetSecurityInfo",SetLastError=true)]
 static extern uint IoGetSecurityInfo(SafeFileHandle handle,int objectType,uint securityInformation,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
 [DllImport("advapi32.dll",EntryPoint="GetSecurityDescriptorLength")]
 static extern uint IoSecurityDescriptorLength(IntPtr descriptor);
 // Same-handle local-NTFS proof: filesystem name and the persistent-ACL flag
 // come from the open handle, and FileFsDeviceInformation (class 4) must not
 // mark a remote device. Volume identity stays bound by the 64-bit
 // FILE_ID_INFO serial inside IoProof; the 32-bit name serial is never
 // compared against it.
 static void IoNtfsProof(SafeFileHandle handle){
  var name=new System.Text.StringBuilder(64);
  IoRequire(IoGetVolumeInformation(handle,IntPtr.Zero,0,IntPtr.Zero,IntPtr.Zero,out uint flags,name,(uint)name.Capacity));
  IoRequire(name.ToString()=="NTFS"&&(flags&0x8)!=0); // FILE_PERSISTENT_ACLS
  int size=Marshal.SizeOf<IO_FS_DEVICE_INFORMATION>();
  IntPtr buffer=Marshal.AllocHGlobal(size);
  try{
   int status=IoQueryVolumeInformation(handle,out IO_STATUS_BLOCK block,buffer,(uint)size,4);
   IoRequire(status==0&&block.Status==IntPtr.Zero&&block.Information==new UIntPtr((uint)size));
   var device=Marshal.PtrToStructure<IO_FS_DEVICE_INFORMATION>(buffer);
   IoRequire(device.DeviceType==0x7&&(device.Characteristics&0x10)==0); // FILE_DEVICE_DISK, not FILE_REMOTE_DEVICE
  }finally{Marshal.FreeHGlobal(buffer);}
 }
 // Same-handle owner+DACL proof over a bounded copy of the self-relative
 // security descriptor. Only basic CommonAce entries are accepted: allow to
 // the current SID, SYSTEM or Administrators, or deny/audit/alarm entries.
 // Object and callback ACEs are rejected outright, so exotic-but-legal ACLs
 // may conservatively fail. For staging paths the protected flag is
 // mandatory because the installed SDDL sets it; reads keep the looser
 // existing privacy bound.
 static void IoAclProof(SafeFileHandle handle,string sid,bool requireProtected){
  IntPtr descriptor=IntPtr.Zero;
  try{
   IoRequire(IoGetSecurityInfo(handle,1,1|4,out _,out _,out _,out _,out descriptor)==0);
   IoRequire(descriptor!=IntPtr.Zero);
   uint length=IoSecurityDescriptorLength(descriptor);
   IoRequire(length>0&&length<=PrivateIoMaxBytes);
   byte[] bytes=new byte[length];
   Marshal.Copy(descriptor,bytes,0,bytes.Length);
   var raw=new RawSecurityDescriptor(bytes,0);
   IoRequire(raw.Owner!=null&&raw.Owner.Value==sid);
   IoRequire((raw.ControlFlags&ControlFlags.DiscretionaryAclPresent)!=0&&raw.DiscretionaryAcl!=null);
   if(requireProtected)IoRequire((raw.ControlFlags&ControlFlags.DiscretionaryAclProtected)!=0);
   foreach(GenericAce ace in raw.DiscretionaryAcl){
    var common=ace as CommonAce;
    IoRequire(common!=null);
    if(common.AceType==AceType.AccessAllowed){
     string who=common.SecurityIdentifier.Value;
     IoRequire(who==sid||who=="S-1-5-18"||who=="S-1-5-32-544");
    }else{
     IoRequire(common.AceType==AceType.AccessDenied||common.AceType==AceType.SystemAudit||common.AceType==AceType.SystemAlarm);
    }
   }
  }finally{if(descriptor!=IntPtr.Zero)IoLocalFree(descriptor);}
 }
 static IoV2Outcome IoV2FailureOutcome(IoV2Request request,string state){
  IoRequest r=request.Common;
  string reason=state=="EXISTS"?"PRIVATE_IO_V2_EXISTS":state=="UNKNOWN"?"PRIVATE_IO_V2_UNKNOWN":"PRIVATE_IO_V2_REJECTED";
  int status=state=="EXISTS"?2:state=="UNKNOWN"?3:1;
  if(r.Operation=="prepare"||r.Operation=="commit-prepared")
   return new IoV2Outcome {Status=status,Response=new {contractVersion=2,operation=r.Operation,path=r.Path,root=r.Root,attemptId=r.AttemptId,stagingPath=r.StagingPath,state,reason}};
  return new IoV2Outcome {Status=status,Response=new {contractVersion=2,operation=r.Operation,path=r.Path,root=r.Root,state,reason}};
 }
 static IoV2Request IoReadV2Request(){
  // Stop at max+1, never ReadToEnd. Parse only after pipe EOF.
  using var input=Console.OpenStandardInput();
  using var buffer=new MemoryStream();
  byte[] chunk=new byte[8192];
  for(;;){
   int remaining=PrivateIoMaxStdinBytes+1-(int)buffer.Length;
   int count=input.Read(chunk,0,Math.Min(chunk.Length,remaining));
   if(count==0)break;
   buffer.Write(chunk,0,count);
   IoRequire(buffer.Length<=PrivateIoMaxStdinBytes);
  }
  byte[] encoded=buffer.ToArray();
  IoRequire(encoded.Length>0&&!(encoded.Length>=3&&encoded[0]==0xef&&encoded[1]==0xbb&&encoded[2]==0xbf));
  string json=new System.Text.UTF8Encoding(false,true).GetString(encoded);
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
  IoRequire(operation=="prepare"||operation=="commit-prepared"||operation=="read-private");
  var names=new HashSet<string>(new[]{"contractVersion","operation","path","root","rootFileId","rootVolumeId","directoryFileId","directoryVolumeId"},StringComparer.Ordinal);
  if(operation=="prepare")names.UnionWith(new[]{"attemptId","stagingPath","bytesBase64"});
  else if(operation=="commit-prepared")names.UnionWith(new[]{"attemptId","stagingPath","fileId","volumeId","expectedSha256","byteLength"});
  else names.UnionWith(new[]{"fileId","volumeId","maxBytes","expectedSha256"});
  IoRequire(fields.Count==names.Count||(operation=="read-private"&&fields.Count==names.Count-1&&!fields.ContainsKey("expectedSha256")));
  foreach(string name in fields.Keys)IoRequire(names.Contains(name));
  IoRequire(IoInteger(fields["contractVersion"])==2);
  var r=new IoRequest {
   Operation=operation,Path=IoCanonical(IoString(fields["path"])),Root=IoCanonical(IoString(fields["root"])),
   RootFileId=IoHex(fields["rootFileId"],32),RootVolumeId=IoHex(fields["rootVolumeId"],16),
   DirectoryFileId=IoHex(fields["directoryFileId"],32),DirectoryVolumeId=IoHex(fields["directoryVolumeId"],16)
  };
  RelativeDirectorySegments(r.Path,r.Root); // Strict descendant; no root-as-file.
  r.Parent=IoCanonical(System.IO.Path.GetDirectoryName(r.Path));
  IoRequire(Same(r.DirectoryVolumeId,r.RootVolumeId));
  if(Same(r.Parent,r.Root))IoRequire(Same(r.DirectoryFileId,r.RootFileId));
  var request=new IoV2Request {Common=r};
  if(operation=="prepare"){
   r.AttemptId=IoHex(fields["attemptId"],32,true);
   // The caller chooses the staging name; it must be a canonical sibling of
   // the target and is never silently defaulted.
   r.StagingPath=IoCanonical(IoString(fields["stagingPath"]));
   RelativeDirectorySegments(r.StagingPath,r.Root);
   IoRequire(Same(IoCanonical(System.IO.Path.GetDirectoryName(r.StagingPath)),r.Parent));
   IoRequire(!Same(r.Path,r.StagingPath));
   r.BytesBase64=IoString(fields["bytesBase64"]);
   IoRequire(r.BytesBase64.Length<=4*((PrivateIoMaxBytes+2)/3));
   // Canonical base64 is fully decoded BEFORE any CREATE_NEW.
   byte[] decoded=Convert.FromBase64String(r.BytesBase64);
   IoRequire(decoded.Length<=PrivateIoMaxBytes&&Convert.ToBase64String(decoded)==r.BytesBase64);
  }else if(operation=="commit-prepared"){
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
   IoRequire(request.ByteLength>=0&&request.ByteLength<=PrivateIoMaxBytes&&Same(r.VolumeId,r.RootVolumeId));
  }else{
   r.FileId=IoHex(fields["fileId"],32);
   r.VolumeId=IoHex(fields["volumeId"],16);
   if(fields.ContainsKey("expectedSha256")){r.ExpectedSha256=IoHex(fields["expectedSha256"],64,true);request.HasExpectedSha256=true;}
   r.MaxBytes=IoInteger(fields["maxBytes"]);
   IoRequire(r.MaxBytes>=0&&r.MaxBytes<=PrivateIoV2MaxReadBytes&&Same(r.VolumeId,r.RootVolumeId));
  }
  return request;
 }
 // Creates the private stage under the locked ancestors and proves it, but
 // never renames: publication is only the paired commit-prepared operation.
 static IoV2Outcome IoV2Prepare(IoV2Request request,string sid,IoDirectoryLocks directories,ref bool attempted){
  IoRequest r=request.Common;
  byte[] payload=Convert.FromBase64String(r.BytesBase64);
  IoRequire(payload.Length<=PrivateIoMaxBytes&&Convert.ToBase64String(payload)==r.BytesBase64);
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
  if(stage.IsInvalid)return IoV2FailureOutcome(request,lastError==80||lastError==183?"EXISTS":"UNKNOWN");
  using(stage){
   var stagingProof=IoFileProof(stage,r.StagingPath,r,sid,0,null);
   IoAclProof(stage,sid,true);
   IoNtfsProof(stage);
   using(var stream=new FileStream(stage,FileAccess.ReadWrite,4096,false)){
    stream.Write(payload,0,payload.Length);
    stream.Flush(true);
    byte[] readback=IoReadExact(stream,payload.Length);
    string sha256=IoSha256(readback);
    var file=IoFileProof(stage,r.StagingPath,r,sid,payload.Length,stagingProof.fileId);
    IoAclProof(stage,sid,true);
    IoNtfsProof(stage);
    var directory=directories.Recheck();
    return new IoV2Outcome {Status=0,Response=new {
     contractVersion=2,operation=r.Operation,path=r.Path,root=r.Root,attemptId=r.AttemptId,stagingPath=r.StagingPath,state="PREPARED",
     file=IoEvidence(file,sid),directory=IoEvidence(directory,sid),byteLength=payload.Length,sha256,
     bytesBase64=Convert.ToBase64String(readback),contentFlushed=true,filesystem="NTFS"
    }};
   }
  }
 }
 // Reopens the exact caller stage under the same locks, re-verifies it, and
 // renames no-replace on the SAME handle. A collision keeps the stage.
 static IoV2Outcome IoV2Commit(IoV2Request request,string sid,IoDirectoryLocks directories,ref bool attempted){
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
    byte[] bytes=IoReadExact(stream,length);
    string sha256=IoSha256(bytes);
    IoRequire(System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(Convert.FromHexString(sha256),Convert.FromHexString(r.ExpectedSha256)));
    directories.Recheck();
    if(!IoRenameNoReplace(handle,r.Path,out int error)){
     directories.Recheck();
     return IoV2FailureOutcome(request,error==80||error==183?"EXISTS":"UNKNOWN");
    }
    stream.Flush(true);
    IoRequire(System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(bytes,IoReadExact(stream,length)));
    var file=IoFileProof(handle,r.Path,r,sid,length,stagingProof.fileId);
    IoAclProof(handle,sid,true);
    IoNtfsProof(handle);
    var directory=directories.Recheck();
    return new IoV2Outcome {Status=0,Response=new {
     contractVersion=2,operation=r.Operation,path=r.Path,root=r.Root,attemptId=r.AttemptId,stagingPath=r.StagingPath,state="PUBLISHED",
     file=IoEvidence(file,sid),directory=IoEvidence(directory,sid),byteLength=length,sha256,
     bytesBase64=Convert.ToBase64String(bytes),contentFlushed=true,filesystem="NTFS",
     stagingDisposition="RENAMED_TO_FINAL",@namespace="EXCLUSIVE_NO_REPLACE",
     durability=new {profile="WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1",scope="PROCESS_CRASH"}
    }};
   }
  }
 }
 static IoV2Outcome IoV2Read(IoV2Request request,string sid,IoDirectoryLocks directories){
  IoRequest r=request.Common;
  IntPtr raw=CreateFileW(r.Path,IoGenericRead|IoReadControl,IoShareRead,IntPtr.Zero,OpenExisting,FileFlagOpenReparsePoint,IntPtr.Zero);
  IoRequire(raw!=new IntPtr(-1));
  using(var handle=new SafeFileHandle(raw,true)){
   var standard=IoInspect(handle,false);
   IoRequire(standard.EndOfFile<=r.MaxBytes&&standard.EndOfFile<=PrivateIoV2MaxReadBytes);
   int length=checked((int)standard.EndOfFile);
   IoAclProof(handle,sid,false);
   IoNtfsProof(handle);
   IoFileProof(handle,r.Path,r,sid,length,r.FileId); // All proofs BEFORE bytes.
   using(var stream=new FileStream(handle,FileAccess.Read,4096,false)){
    byte[] bytes=IoReadExact(stream,length,PrivateIoV2MaxReadBytes);
    string sha256=IoSha256(bytes);
    if(request.HasExpectedSha256)
     IoRequire(System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(Convert.FromHexString(sha256),Convert.FromHexString(r.ExpectedSha256)));
    var file=IoFileProof(handle,r.Path,r,sid,length,r.FileId);
    IoAclProof(handle,sid,false);
    IoNtfsProof(handle);
    var directory=directories.Recheck();
    // Private bytes go ONLY to the guarded captured pipe, never diagnostics.
    return new IoV2Outcome {Status=0,Response=new {
     contractVersion=2,operation=r.Operation,path=r.Path,root=r.Root,state="READ",
     file=IoEvidence(file,sid),directory=IoEvidence(directory,sid),bytesBase64=Convert.ToBase64String(bytes),byteLength=length,sha256,filesystem="NTFS"
    }};
   }
  }
 }
 static int PrivateIoV2Mode(){
  // Same captured-pipe invariant as v1: both standard handles must be pipes.
  if(!IoPipes()){Console.Error.Write("WINDOWS_PRIVATE_IO_UNSAFE");return 1;}
  IoV2Request request=null;
  bool attempted=false;
  bool outputAttempted=false;
  IoV2Outcome outcome=null;
  try{
   request=IoReadV2Request();
   // A commit operates on a stage that already exists once parsed; any later
   // failure is uncertain rather than a clean rejection.
   if(request.Common.Operation=="commit-prepared")attempted=true;
   using(var identity=WindowsIdentity.GetCurrent()){
    string sid=identity.User.Value;
    using(var directories=new IoDirectoryLocks(request.Common,sid)){
     if(request.Common.Operation=="prepare")outcome=IoV2Prepare(request,sid,directories,ref attempted);
     else if(request.Common.Operation=="commit-prepared")outcome=IoV2Commit(request,sid,directories,ref attempted);
     else outcome=IoV2Read(request,sid,directories);
    }
   }
  }catch{
   // Disposal failures land here too: every owned handle scope has ended (or
   // failed to), and only an outcome assembled afterwards may be emitted.
   if(request!=null){
    try{outcome=IoV2FailureOutcome(request,attempted?"UNKNOWN":"REJECTED");}catch{outcome=null;}
   }else outcome=null;
  }
  if(outcome==null){Console.Error.Write("WINDOWS_PRIVATE_IO_UNSAFE");return attempted||outputAttempted?3:1;}
  try{return IoOutput(outcome.Response,outcome.Status,ref outputAttempted,request!=null&&request.Common.Operation=="read-private"?PrivateIoV2MaxReadOutputBytes:PrivateIoMaxOutputBytes);}
  catch{Console.Error.Write("WINDOWS_PRIVATE_IO_UNSAFE");return 3;}
 }
 // Exclusive directory creation. One single basename below the ALREADY-HELD
 // parent handle through NtCreateFile FILE_CREATE: create-or-open semantics
 // are never used, and nothing is deleted after a failure. The child is
 // proven on the returned handle and every ancestor lock is re-walked before
 // the outcome is assembled; any doubt after the create call is UNKNOWN.
 const int ExclusiveMaxStdinBytes=4096;
 const int ExclusiveMaxOutputBytes=16384;
 const uint IoSynchronize=0x00100000;
 const uint IoObjCaseInsensitive=0x00000040;
 const uint IoFileAttributeDirectory=0x00000010;
 const uint IoFileDirectoryFile=0x00000001;
 const uint IoFileSynchronousIoNonAlert=0x00000020;
 const uint IoFileOpenReparsePoint=0x00200000;
 const uint IoFileCreate=2;
 const ulong IoFileCreated=2;
 const int IoStatusObjectNameCollision=unchecked((int)0xC0000035);
 [StructLayout(LayoutKind.Sequential)]
 struct EXCLUSIVE_UNICODE_STRING { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }
 [StructLayout(LayoutKind.Sequential)]
 struct EXCLUSIVE_OBJECT_ATTRIBUTES { public uint Length; public IntPtr RootDirectory; public IntPtr ObjectName; public uint Attributes; public IntPtr SecurityDescriptor; public IntPtr SecurityQualityOfService; }
 [DllImport("ntdll.dll",EntryPoint="NtCreateFile")]
 static extern int ExclusiveNtCreateFile(out SafeFileHandle handle,uint access,ref EXCLUSIVE_OBJECT_ATTRIBUTES attributes,out IO_STATUS_BLOCK status,IntPtr allocationSize,uint fileAttributes,uint shareAccess,uint disposition,uint options,IntPtr eaBuffer,uint eaLength);
 static IoRequest IoReadExclusiveRequest(){
  // Stop at max+1, never ReadToEnd. Parse only after pipe EOF.
  using var input=Console.OpenStandardInput();
  using var buffer=new MemoryStream();
  byte[] chunk=new byte[8192];
  for(;;){
   int remaining=ExclusiveMaxStdinBytes+1-(int)buffer.Length;
   int count=input.Read(chunk,0,Math.Min(chunk.Length,remaining));
   if(count==0)break;
   buffer.Write(chunk,0,count);
   IoRequire(buffer.Length<=ExclusiveMaxStdinBytes);
  }
  byte[] encoded=buffer.ToArray();
  IoRequire(encoded.Length>0&&!(encoded.Length>=3&&encoded[0]==0xef&&encoded[1]==0xbb&&encoded[2]==0xbf));
  string json=new System.Text.UTF8Encoding(false,true).GetString(encoded);
  using var document=JsonDocument.Parse(json,new JsonDocumentOptions {AllowTrailingCommas=false,CommentHandling=JsonCommentHandling.Disallow,MaxDepth=4});
  JsonElement obj=document.RootElement;
  IoRequire(obj.ValueKind==JsonValueKind.Object);
  var fields=new Dictionary<string,JsonElement>(StringComparer.Ordinal);
  foreach(JsonProperty property in obj.EnumerateObject()){
   IoRequire(!fields.ContainsKey(property.Name));
   fields.Add(property.Name,property.Value);
  }
  var names=new HashSet<string>(new[]{"contractVersion","operation","path","root","attemptId","rootFileId","rootVolumeId","directoryFileId","directoryVolumeId"},StringComparer.Ordinal);
  IoRequire(fields.Count==names.Count);
  foreach(string name in fields.Keys)IoRequire(names.Contains(name));
  IoRequire(IoInteger(fields["contractVersion"])==1);
  string operation=IoString(fields["operation"]);
  IoRequire(operation=="create-directory");
  var r=new IoRequest {
   Operation=operation,Path=IoCanonical(IoString(fields["path"])),Root=IoCanonical(IoString(fields["root"])),
   AttemptId=IoHex(fields["attemptId"],32,true),
   RootFileId=IoHex(fields["rootFileId"],32),RootVolumeId=IoHex(fields["rootVolumeId"],16),
   DirectoryFileId=IoHex(fields["directoryFileId"],32),DirectoryVolumeId=IoHex(fields["directoryVolumeId"],16)
  };
  RelativeDirectorySegments(r.Path,r.Root); // Strict descendant; never the root itself.
  r.Parent=IoCanonical(System.IO.Path.GetDirectoryName(r.Path));
  IoRequire(Same(r.DirectoryVolumeId,r.RootVolumeId));
  if(Same(r.Parent,r.Root))IoRequire(Same(r.DirectoryFileId,r.RootFileId));
  return r;
 }
 static IoV2Outcome IoExclusiveFailure(IoRequest r,string state){
  string reason=state=="EXISTS"?"EXCLUSIVE_DIRECTORY_EXISTS":state=="UNKNOWN"?"EXCLUSIVE_DIRECTORY_UNKNOWN":"EXCLUSIVE_DIRECTORY_REJECTED";
  int status=state=="EXISTS"?2:state=="UNKNOWN"?3:1;
  return new IoV2Outcome{Status=status,Response=new{contractVersion=1,operation=r.Operation,path=r.Path,root=r.Root,attemptId=r.AttemptId,state,reason}};
 }
 static IoV2Outcome IoExclusiveCreate(IoRequest r,string sid,IoDirectoryLocks directories,ref bool attempted){
  string[] segments=ParseDirectorySegments(r.Path);
  string basename=segments[segments.Length-1];
  byte[] nameBytes=System.Text.Encoding.Unicode.GetBytes(basename);
  IntPtr descriptor=IntPtr.Zero;
  IntPtr nameBuffer=IntPtr.Zero;
  IntPtr nameObject=IntPtr.Zero;
  int status;
  IO_STATUS_BLOCK block;
  SafeFileHandle child;
  try{
   // OICI so SQLite children created later inside this directory inherit
   // private ACEs; the new directory DACL itself is protected.
   string sddl="O:"+sid+"G:"+sid+"D:P(A;OICI;FA;;;"+sid+")";
   IoRequire(IoConvertSecurityDescriptor(sddl,1,out descriptor,out _));
   nameBuffer=Marshal.AllocHGlobal(nameBytes.Length);
   Marshal.Copy(nameBytes,0,nameBuffer,nameBytes.Length);
   var name=new EXCLUSIVE_UNICODE_STRING{Length=(ushort)nameBytes.Length,MaximumLength=(ushort)nameBytes.Length,Buffer=nameBuffer};
   nameObject=Marshal.AllocHGlobal(Marshal.SizeOf<EXCLUSIVE_UNICODE_STRING>());
   Marshal.StructureToPtr(name,nameObject,false);
   var attributes=new EXCLUSIVE_OBJECT_ATTRIBUTES{
    Length=(uint)Marshal.SizeOf<EXCLUSIVE_OBJECT_ATTRIBUTES>(),
    RootDirectory=directories.ParentHandle.DangerousGetHandle(),
    ObjectName=nameObject,
    Attributes=IoObjCaseInsensitive,
    SecurityDescriptor=descriptor,
    SecurityQualityOfService=IntPtr.Zero
   };
   attempted=true; // Even an unsuccessful NtCreateFile call is conservatively UNKNOWN.
   status=ExclusiveNtCreateFile(out child,FileReadAttributes|IoReadControl|IoSynchronize,ref attributes,out block,IntPtr.Zero,IoFileAttributeDirectory,IoShareRead,IoFileCreate,IoFileDirectoryFile|IoFileSynchronousIoNonAlert|IoFileOpenReparsePoint,IntPtr.Zero,0);
  }finally{
   if(descriptor!=IntPtr.Zero)IoLocalFree(descriptor);
   if(nameBuffer!=IntPtr.Zero)Marshal.FreeHGlobal(nameBuffer);
   if(nameObject!=IntPtr.Zero)Marshal.FreeHGlobal(nameObject);
  }
  if(status==IoStatusObjectNameCollision&&(child==null||child.IsInvalid)){child?.Dispose();return IoExclusiveFailure(r,"EXISTS");}
  if(status!=0||block.Status!=IntPtr.Zero||block.Information.ToUInt64()!=IoFileCreated||child==null||child.IsInvalid){
   child?.Dispose();
   return IoExclusiveFailure(r,"UNKNOWN");
  }
  using(child){
   IoInspect(child,true);
   IoNtfsProof(child);
   IoAclProof(child,sid,true);
   var directoryProof=FolioWindowsProbe.RunHeldDirectory(child,directories.RootHandle,r.Path,r.Root,sid);
   HandleIdentity(child,out string handleFileId,out string handleVolumeId);
   IoRequire(Same(handleFileId,directoryProof.fileId)&&Same(handleVolumeId,directoryProof.volumeId));
   IoRequire(Same(directoryProof.rootFileId,r.RootFileId)&&Same(directoryProof.rootVolumeId,r.RootVolumeId)&&Same(directoryProof.volumeId,r.RootVolumeId));
   IoRequire(!Same(directoryProof.fileId,r.RootFileId)&&!Same(directoryProof.fileId,r.DirectoryFileId));
   var parentProof=directories.RecheckExclusive();
   var rootProof=directories.RootEvidence();
   return new IoV2Outcome{Status=0,Response=new{
    contractVersion=1,operation=r.Operation,path=r.Path,root=r.Root,attemptId=r.AttemptId,state="CREATED",
    rootEvidence=IoEvidence(rootProof,sid),parent=IoEvidence(parentProof,sid),directory=IoEvidence(directoryProof,sid),
    handleFileId,handleVolumeId,filesystem="NTFS",ancestorsHeld=true,daclProtected=true,@namespace="EXCLUSIVE_CREATE"
   }};
  }
 }
 static int ExclusiveDirectoryMode(){
  // Same captured-pipe invariant as the private I/O modes.
  if(!IoPipes()){Console.Error.Write("WINDOWS_PRIVATE_IO_UNSAFE");return 1;}
  IoRequest request=null;
  bool attempted=false;
  bool outputAttempted=false;
  IoV2Outcome outcome=null;
  try{
   request=IoReadExclusiveRequest();
   using(var identity=WindowsIdentity.GetCurrent()){
    string sid=identity.User.Value;
    using(var directories=new IoDirectoryLocks(request,sid)){
     directories.RecheckExclusive();
     outcome=IoExclusiveCreate(request,sid,directories,ref attempted);
    }
   }
  }catch{
   // Disposal failures land here too: once the create may have run the
   // outcome is UNKNOWN, and only an assembled outcome may be emitted.
   if(request!=null){
    try{outcome=IoExclusiveFailure(request,attempted?"UNKNOWN":"REJECTED");}catch{outcome=null;}
   }else outcome=null;
  }
  if(outcome==null){Console.Error.Write("WINDOWS_PRIVATE_IO_UNSAFE");return attempted||outputAttempted?3:1;}
  try{return IoOutput(outcome.Response,outcome.Status,ref outputAttempted,ExclusiveMaxOutputBytes);}
  catch{Console.Error.Write("WINDOWS_PRIVATE_IO_UNSAFE");return 3;}
 }
 static int Main(string[] args) {
  try {
   if(args.Length==1&&args[0]=="--private-io-v1")return PrivateIoMode();
   if(args.Length==1&&args[0]=="--private-io-v2")return PrivateIoV2Mode();
   if(args.Length==1&&args[0]=="--private-recovery-io")return PrivateRecoveryIoMode();
   if(args.Length==1&&args[0]=="--private-journal-snapshot")return PrivateJournalSnapshotMode();
   if(args.Length==1&&args[0]=="--private-backup-artifact")return PrivateBackupArtifactMode();
   if(args.Length==1&&args[0]=="--private-persistence-io")return PrivatePersistenceIoMode();
   if(args.Length==1&&args[0]=="--private-transfer-io")return RunPrivateTransferIo();
   if(args.Length==1&&args[0]=="--private-authority-lease")return PrivateAuthorityLeaseMode();
   if(args.Length==1&&args[0]=="--exclusive-directory-v1")return ExclusiveDirectoryMode();
   if(!OperatingSystem.IsWindows()||(args.Length!=2&&args.Length!=3))throw new InvalidOperationException();
   string mode=args.Length==3?args[2]:"probe";
   if(mode!="probe"&&mode!="create"&&mode!="open"&&mode!="directory")throw new InvalidOperationException();
   using(var identity=WindowsIdentity.GetCurrent()){
    string sid=identity.User.Value;
    if(mode=="create")return Create(args,sid);
    if(mode=="open")return Open(args,sid);
    if(mode=="directory")return DirectoryMode(args,sid);
    return Probe(args,sid);
   }
  }catch{Console.Error.Write("WINDOWS_PRIVATE_ROOT_UNSAFE");return 1;}
 }
}
