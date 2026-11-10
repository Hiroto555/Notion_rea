using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text.Json;
using System.Runtime.Versioning;
using Microsoft.Win32.SafeHandles;
[SupportedOSPlatform("windows")]
internal static class PrivateRootProbeProgram {
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
 static int Main(string[] args) {
  try {
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
