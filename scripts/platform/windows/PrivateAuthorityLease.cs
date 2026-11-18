using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

// A dedicated owned process keeps the authority namespace and main database
// pinned for the entire SQLite lifetime. No PID/marker adoption or file writes.
internal static partial class PrivateRootProbeProgram {
 const int AuthorityLeaseLineLimit=8192;
 static Dictionary<string,JsonElement> LeaseLine(Stream input){
  using var buffer=new MemoryStream();
  for(;;){
   int value=input.ReadByte();
   IoRequire(value>=0); // EOF is loss of the lease, not a close receipt.
   if(value==10)break;
   IoRequire(value>=0x20&&value<=0x7e&&buffer.Length<AuthorityLeaseLineLimit);
   buffer.WriteByte((byte)value);
  }
  using var document=JsonDocument.Parse(buffer.ToArray(),new JsonDocumentOptions {MaxDepth=3});
  IoRequire(document.RootElement.ValueKind==JsonValueKind.Object);
  var fields=new Dictionary<string,JsonElement>(StringComparer.Ordinal);
  foreach(var property in document.RootElement.EnumerateObject()){
   IoRequire(!fields.ContainsKey(property.Name));
   fields.Add(property.Name,property.Value.Clone());
  }
  return fields;
 }
 static void LeaseFields(Dictionary<string,JsonElement> fields,string[] expected){
  IoRequire(fields.Count==expected.Length);
  foreach(string name in expected)IoRequire(fields.ContainsKey(name));
 }
 static void LeaseOutput(Stream output,object value){
  byte[] bytes=JsonSerializer.SerializeToUtf8Bytes(value);
  IoRequire(bytes.Length<=AuthorityLeaseLineLimit);
  output.Write(bytes,0,bytes.Length);output.WriteByte(10);output.Flush();
 }
 static object LeaseProof(SafeFileHandle file,IoDirectoryLocks directories,IoRequest request,string sid,string nonce,int sequence){
  IoInspect(file,false);
  IoAclProof(file,sid,false);IoNtfsProof(file);
  var proof=IoProof(file,request.Path,request,sid);
  IoRequire(Same(proof.fileId,request.FileId)&&Same(proof.volumeId,request.VolumeId));
  var directory=directories.RecheckExclusive();
  return new {contractVersion=1,state="HELD",nonce,sequence,
   file=IoEvidence(proof,sid),directory=IoEvidence(directory,sid)};
 }
 static int PrivateAuthorityLeaseMode(){
  if(!IoPipes())return 1;
  string nonce=null;
  int sequence=0;
  try{
   using var input=Console.OpenStandardInput();
   using var output=Console.OpenStandardOutput();
   var fields=LeaseLine(input);
   LeaseFields(fields,new[]{"contractVersion","nonce","root","path","rootFileId","rootVolumeId",
    "directoryFileId","directoryVolumeId","fileId","volumeId"});
   IoRequire(IoInteger(fields["contractVersion"])==1);
   nonce=IoHex(fields["nonce"],32,true);
   var request=new IoRequest {
    Root=IoCanonical(IoString(fields["root"])),Path=IoCanonical(IoString(fields["path"])),
    RootFileId=IoHex(fields["rootFileId"],32),RootVolumeId=IoHex(fields["rootVolumeId"],16),
    DirectoryFileId=IoHex(fields["directoryFileId"],32),DirectoryVolumeId=IoHex(fields["directoryVolumeId"],16),
    FileId=IoHex(fields["fileId"],32),VolumeId=IoHex(fields["volumeId"],16)
   };
   request.Parent=IoCanonical(Path.GetDirectoryName(request.Path));
   RelativeDirectorySegments(request.Path,request.Root);
   IoRequire(Same(request.VolumeId,request.RootVolumeId)&&Same(request.DirectoryVolumeId,request.RootVolumeId));
   using(var identity=WindowsIdentity.GetCurrent()){
    string sid=identity.User.Value;
    using(var directories=new IoDirectoryLocks(request,sid)){
     // FILE_SHARE_READ | FILE_SHARE_WRITE permits SQLite updates. Deliberately
     // omit FILE_SHARE_DELETE so the authority file cannot be renamed/replaced.
     IntPtr raw=CreateFileW(request.Path,FileReadAttributes|IoReadControl,3,IntPtr.Zero,
      OpenExisting,FileFlagOpenReparsePoint,IntPtr.Zero);
     IoRequire(raw!=new IntPtr(-1));
     using(var file=new SafeFileHandle(raw,true)){
      LeaseOutput(output,LeaseProof(file,directories,request,sid,nonce,sequence));
      for(;;){
       var command=LeaseLine(input);
       LeaseFields(command,new[]{"command","nonce","sequence"});
       IoRequire(IoHex(command["nonce"],32,true)==nonce);
       int next=IoInteger(command["sequence"]);
       IoRequire(sequence<int.MaxValue&&next==sequence+1);
       sequence=next;
       string operation=IoString(command["command"]);
       IoRequire(operation=="CHECK"||operation=="CLOSE");
       // A final proof precedes disposal; CLOSED is emitted only after every
       // owned file/directory/identity handle has left its scope.
       object held=LeaseProof(file,directories,request,sid,nonce,sequence);
       if(operation=="CLOSE")break;
       LeaseOutput(output,held);
      }
     }
    }
   }
   LeaseOutput(output,new {contractVersion=1,state="CLOSED",nonce,sequence});
   return 0;
  }catch{
   // No receipt is a positive closure or nonapplication proof.
   Console.Error.Write("WINDOWS_AUTHORITY_LEASE_UNKNOWN");
   return 3;
  }
 }
}
