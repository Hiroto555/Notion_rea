[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$Root,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$Nonce
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Write-CandidateResult {
    param([object]$Result)

    $directories = @()
    foreach ($entry in $Result.directories) {
        $directories += [ordered]@{
            name     = [string]$entry.name
            path     = [string]$entry.path
            fileId   = [string]$entry.fileId
            volumeId = [string]$entry.volumeId
        }
    }
    $output = [ordered]@{
        candidate       = [bool]$Result.candidate
        code            = [string]$Result.code
        created         = [bool]$Result.created
        directories     = $directories
        nonce           = [string]$Result.nonce
        ownerSid        = [string]$Result.ownerSid
        ownershipFileId = [string]$Result.ownershipFileId
        ownershipPath   = [string]$Result.ownershipPath
        physical        = 'NOT_RUN'
        root            = [string]$Result.root
        rootFileId      = [string]$Result.rootFileId
        volumeId        = [string]$Result.volumeId
    }
    [Console]::Out.Write(($output | ConvertTo-Json -Compress -Depth 4))
}

try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        throw 'WINDOWS_CANDIDATE_ROOT_PLATFORM'
    }
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    if ($null -eq $identity -or $null -eq $identity.User) {
        throw 'WINDOWS_CANDIDATE_ROOT_IDENTITY'
    }
    $sid = $identity.User.Value
    if ([string]::IsNullOrWhiteSpace($sid)) {
        throw 'WINDOWS_CANDIDATE_ROOT_IDENTITY'
    }

    Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public sealed class FolioWindowsCandidateEntry
{
    public string name { get; set; }
    public string path { get; set; }
    public string fileId { get; set; }
    public string volumeId { get; set; }
}

public sealed class FolioWindowsCandidateResult
{
    public bool candidate { get; set; }
    public bool created { get; set; }
    public string code { get; set; }
    public string root { get; set; }
    public string nonce { get; set; }
    public string ownerSid { get; set; }
    public string volumeId { get; set; }
    public string rootFileId { get; set; }
    public string ownershipPath { get; set; }
    public string ownershipFileId { get; set; }
    public FolioWindowsCandidateEntry[] directories { get; set; }
}

internal sealed class CandidateFailure : Exception
{
    public readonly string Code;

    public CandidateFailure(string code) : base(code)
    {
        Code = code;
    }
}

public static class FolioWindowsCandidateRoot
{
    private const uint FILE_READ_ATTRIBUTES = 0x00000080;
    private const uint READ_CONTROL = 0x00020000;
    private const uint GENERIC_READ = 0x80000000;
    private const uint GENERIC_WRITE = 0x40000000;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint FILE_SHARE_DELETE = 0x00000004;
    private const uint OPEN_EXISTING = 3;
    private const uint CREATE_NEW = 1;
    private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
    private const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
    private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
    private const uint INVALID_FILE_ATTRIBUTES = 0xFFFFFFFF;
    private const uint FILE_ALL_ACCESS = 0x001F01FF;
    private const uint DANGEROUS_MASK =
        0x00000002 |
        0x00000004 |
        0x00000010 |
        0x00000040 |
        0x00000100 |
        0x00040000 |
        0x00080000 |
        0x10000000 |
        0x40000000;
    private const uint SE_FILE_OBJECT = 1;
    private const uint OWNER_SECURITY_INFORMATION = 0x00000001;
    private const uint DACL_SECURITY_INFORMATION = 0x00000004;
    private const int FileStandardInfo = 1;
    private const int FileAttributeTagInfo = 9;
    private const int FileIdInfo = 18;
    private const int AclSizeInformation = 2;
    private const int SECURITY_DESCRIPTOR_MIN_LENGTH = 20;
    private const uint ACL_REVISION = 2;
    private const uint SE_DACL_PROTECTED = 0x0400;
    private const uint INHERIT_FLAGS = 0x03;
    private const uint FILE_REMOTE_DEVICE = 0x00000001;
    private const int ERROR_FILE_NOT_FOUND = 2;
    private const int ERROR_PATH_NOT_FOUND = 3;
    private const int ERROR_FILE_EXISTS = 80;
    private const int ERROR_ALREADY_EXISTS = 183;
    private const int MAX_PATH_LENGTH = 4096;
    private const int MAX_SEGMENT_LENGTH = 255;
    private const string SYSTEM_SID = "S-1-5-18";
    private const string ADMIN_SID = "S-1-5-32-544";
    private const byte AccessAllowedAceType = 0;
    private const byte AccessDeniedAceType = 1;
    private const byte SystemAuditAceType = 2;
    private const byte SystemAlarmAceType = 3;
    private const byte AccessAllowedCompoundAceType = 4;
    private const byte AccessAllowedObjectAceType = 5;
    private const byte AccessDeniedObjectAceType = 6;
    private const byte SystemAuditObjectAceType = 7;
    private const byte SystemAlarmObjectAceType = 8;
    private const byte AccessAllowedCallbackAceType = 9;
    private const byte AccessDeniedCallbackAceType = 10;
    private const byte AccessAllowedCallbackObjectAceType = 11;
    private const byte AccessDeniedCallbackObjectAceType = 12;
    private const byte SystemAuditCallbackAceType = 13;
    private const byte SystemAlarmCallbackAceType = 14;
    private const byte SystemAuditCallbackObjectAceType = 15;
    private const byte SystemAlarmCallbackObjectAceType = 16;
    private const byte SystemMandatoryLabelAceType = 17;
    private const byte SystemResourceAttributeAceType = 18;
    private const byte SystemScopedPolicyIdAceType = 19;
    private const byte SystemProcessTrustLabelAceType = 20;
    private const byte SystemAccessFilterAceType = 21;

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)]
        public bool bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FILE_ATTRIBUTE_TAG_INFO
    {
        public uint FileAttributes;
        public uint ReparseTag;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FILE_STANDARD_INFO
    {
        public long AllocationSize;
        public long EndOfFile;
        public uint NumberOfLinks;
        [MarshalAs(UnmanagedType.U1)]
        public bool DeletePending;
        [MarshalAs(UnmanagedType.U1)]
        public bool Directory;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FILE_ID_128
    {
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)]
        public byte[] Identifier;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FILE_ID_INFO
    {
        public ulong VolumeSerialNumber;
        public FILE_ID_128 FileId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ACL_SIZE_INFORMATION
    {
        public uint AceCount;
        public uint AclBytesInUse;
        public uint AclBytesFree;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateDirectoryW(string lpPathName, ref SECURITY_ATTRIBUTES lpSecurityAttributes);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(
        string lpFileName,
        uint dwDesiredAccess,
        uint dwShareMode,
        IntPtr lpSecurityAttributes,
        uint dwCreationDisposition,
        uint dwFlagsAndAttributes,
        IntPtr hTemplateFile);

    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileWithSecurityW(
        string lpFileName,
        uint dwDesiredAccess,
        uint dwShareMode,
        ref SECURITY_ATTRIBUTES lpSecurityAttributes,
        uint dwCreationDisposition,
        uint dwFlagsAndAttributes,
        IntPtr hTemplateFile);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFileAttributesW(string lpFileName);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleW(
        SafeFileHandle hFile,
        StringBuilder lpszFilePath,
        uint cchFilePath,
        uint dwFlags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandleEx(
        SafeFileHandle hFile,
        int fileInformationClass,
        out FILE_ATTRIBUTE_TAG_INFO info,
        uint dwBufferSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandleEx(
        SafeFileHandle hFile,
        int fileInformationClass,
        out FILE_STANDARD_INFO info,
        uint dwBufferSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandleEx(
        SafeFileHandle hFile,
        int fileInformationClass,
        out FILE_ID_INFO info,
        uint dwBufferSize);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetVolumeInformationByHandleW(
        SafeFileHandle hFile,
        StringBuilder lpVolumeNameBuffer,
        uint nVolumeNameSize,
        out uint lpVolumeSerialNumber,
        out uint lpMaximumComponentLength,
        out uint lpFileSystemFlags,
        StringBuilder lpFileSystemNameBuffer,
        uint nFileSystemNameSize);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern uint GetSecurityInfo(
        SafeFileHandle handle,
        uint objectType,
        uint securityInfo,
        out IntPtr ppsidOwner,
        out IntPtr ppsidGroup,
        out IntPtr ppDacl,
        out IntPtr ppSacl,
        out IntPtr ppSecurityDescriptor);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetSecurityDescriptorOwner(
        IntPtr pSecurityDescriptor,
        out IntPtr pOwner,
        [MarshalAs(UnmanagedType.Bool)] out bool bOwnerDefaulted);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetSecurityDescriptorDacl(
        IntPtr pSecurityDescriptor,
        [MarshalAs(UnmanagedType.Bool)] out bool bDaclPresent,
        out IntPtr pDacl,
        [MarshalAs(UnmanagedType.Bool)] out bool bDaclDefaulted);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetSecurityDescriptorControl(
        IntPtr pSecurityDescriptor,
        out ushort pControl,
        out uint lpdwRevision);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetAclInformation(
        IntPtr pAcl,
        out ACL_SIZE_INFORMATION pAclInformation,
        uint dwAclInformationLength,
        int dwAclInformationClass);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetAce(
        IntPtr pAcl,
        uint dwAceIndex,
        out IntPtr pAce);

    [DllImport("advapi32.dll")]
    private static extern uint GetLengthSid(IntPtr pSid);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ConvertSidToStringSidW(IntPtr Sid, out IntPtr StringSid);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ConvertStringSidToSidW(string StringSid, out IntPtr Sid);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr hMem);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool InitializeSecurityDescriptor(
        IntPtr pSecurityDescriptor,
        uint dwRevision);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetSecurityDescriptorOwner(
        IntPtr pSecurityDescriptor,
        IntPtr pOwner,
        [MarshalAs(UnmanagedType.Bool)] bool bOwnerDefaulted);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetSecurityDescriptorGroup(
        IntPtr pSecurityDescriptor,
        IntPtr pGroup,
        [MarshalAs(UnmanagedType.Bool)] bool bGroupDefaulted);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetSecurityDescriptorDacl(
        IntPtr pSecurityDescriptor,
        [MarshalAs(UnmanagedType.Bool)] bool bDaclPresent,
        IntPtr pDacl,
        [MarshalAs(UnmanagedType.Bool)] bool bDaclDefaulted);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetSecurityDescriptorControl(
        IntPtr pSecurityDescriptor,
        ushort controlMask,
        ushort controlBits);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool InitializeAcl(
        IntPtr pAcl,
        uint nAclLength,
        uint dwAclRevision);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AddAccessAllowedAceEx(
        IntPtr pAcl,
        uint dwAceRevision,
        uint AceFlags,
        uint AccessMask,
        IntPtr pSid);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WriteFile(
        SafeFileHandle hFile,
        byte[] lpBuffer,
        uint nNumberOfBytesToWrite,
        out uint lpNumberOfBytesWritten,
        IntPtr lpOverlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ReadFile(
        SafeFileHandle hFile,
        byte[] lpBuffer,
        uint nNumberOfBytesToRead,
        out uint lpNumberOfBytesRead,
        IntPtr lpOverlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool FlushFileBuffers(SafeFileHandle hFile);

    private sealed class PrivateDirectoryDescriptor : IDisposable
    {
        private IntPtr descriptor;
        private IntPtr owner;
        private IntPtr group;
        private IntPtr acl;
        private IntPtr system;

        public IntPtr Pointer
        {
            get { return descriptor; }
        }

        public PrivateDirectoryDescriptor(string currentSid)
        {
            owner = AllocateSid(currentSid);
            group = AllocateSid(currentSid);
            system = AllocateSid(SYSTEM_SID);
            descriptor = Marshal.AllocHGlobal(SECURITY_DESCRIPTOR_MIN_LENGTH);
            if (!InitializeSecurityDescriptor(descriptor, 1))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            if (!SetSecurityDescriptorOwner(descriptor, owner, false) ||
                !SetSecurityDescriptorGroup(descriptor, group, false))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            bool addSystem = !AsciiEqualsIgnoreCase(currentSid, SYSTEM_SID);
            int ownerLength = (int)GetLengthSid(owner);
            int aclSize = 8 + (8 + ownerLength);
            if (addSystem)
            {
                aclSize += 8 + (int)GetLengthSid(system);
            }
            acl = Marshal.AllocHGlobal(aclSize);
            if (!InitializeAcl(acl, (uint)aclSize, ACL_REVISION))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            if (!AddAccessAllowedAceEx(acl, ACL_REVISION, INHERIT_FLAGS, FILE_ALL_ACCESS, owner))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            if (addSystem &&
                !AddAccessAllowedAceEx(acl, ACL_REVISION, INHERIT_FLAGS, FILE_ALL_ACCESS, system))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            if (!SetSecurityDescriptorDacl(descriptor, true, acl, false))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            if (!SetSecurityDescriptorControl(descriptor, (ushort)SE_DACL_PROTECTED, (ushort)SE_DACL_PROTECTED))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
        }

        public void Dispose()
        {
            if (acl != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(acl);
                acl = IntPtr.Zero;
            }
            if (descriptor != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(descriptor);
                descriptor = IntPtr.Zero;
            }
            if (owner != IntPtr.Zero)
            {
                LocalFree(owner);
                owner = IntPtr.Zero;
            }
            if (group != IntPtr.Zero)
            {
                LocalFree(group);
                group = IntPtr.Zero;
            }
            if (system != IntPtr.Zero)
            {
                LocalFree(system);
                system = IntPtr.Zero;
            }
        }
    }

    private static readonly HashSet<string> ReservedNames = BuildReservedNames();

    private static HashSet<string> BuildReservedNames()
    {
        HashSet<string> names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        names.Add("CON");
        names.Add("PRN");
        names.Add("AUX");
        names.Add("NUL");
        names.Add("CLOCK$");
        names.Add("CONIN$");
        names.Add("CONOUT$");
        for (int index = 1; index <= 9; index++)
        {
            names.Add("COM" + index.ToString());
            names.Add("LPT" + index.ToString());
        }
        return names;
    }

    private static IntPtr AllocateSid(string value)
    {
        IntPtr sid;
        if (!ConvertStringSidToSidW(value, out sid) || sid == IntPtr.Zero)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        return sid;
    }

    private static string AsciiCaseFold(string value)
    {
        if (value == null)
        {
            return null;
        }
        StringBuilder folded = new StringBuilder(value.Length);
        for (int index = 0; index < value.Length; index++)
        {
            char item = value[index];
            if (item >= 'A' && item <= 'Z')
            {
                item = (char)(item + 32);
            }
            folded.Append(item);
        }
        return folded.ToString();
    }

    private static bool AsciiEqualsIgnoreCase(string left, string right)
    {
        if (left == null || right == null)
        {
            return left == right;
        }
        return String.Equals(AsciiCaseFold(left), AsciiCaseFold(right), StringComparison.Ordinal);
    }

    private static bool IsAsciiLetter(char value)
    {
        return (value >= 'A' && value <= 'Z') || (value >= 'a' && value <= 'z');
    }

    private static bool HasShortNameAlias(string segment)
    {
        for (int index = 0; index + 1 < segment.Length; index++)
        {
            if (segment[index] == '~' && segment[index + 1] >= '0' && segment[index + 1] <= '9')
            {
                return true;
            }
        }
        return false;
    }

    private static void ValidateSegment(string segment)
    {
        if (segment.Length == 0 || segment.Length > MAX_SEGMENT_LENGTH)
        {
            throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_INPUT");
        }
        if (segment == "." || segment == "..")
        {
            throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_INPUT");
        }
        for (int index = 0; index < segment.Length; index++)
        {
            char item = segment[index];
            if (item < 0x20 || item == 0x7f)
            {
                throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_INPUT");
            }
            if (item == ':' || item == '<' || item == '>' || item == '"' ||
                item == '|' || item == '?' || item == '*')
            {
                throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_INPUT");
            }
        }
        char last = segment[segment.Length - 1];
        if (last == ' ' || last == '.')
        {
            throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_INPUT");
        }
        if (HasShortNameAlias(segment))
        {
            throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_INPUT");
        }
        int dot = segment.IndexOf('.');
        string stem = (dot >= 0 ? segment.Substring(0, dot) : segment).ToUpperInvariant();
        if (ReservedNames.Contains(stem))
        {
            throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_INPUT");
        }
    }

    private static string NormalizeStrict(string input, bool allowDriveRoot)
    {
        if (input == null || input.Length == 0 || input.Length > MAX_PATH_LENGTH)
        {
            throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_INPUT");
        }
        for (int index = 0; index < input.Length; index++)
        {
            char item = input[index];
            if (item < 0x20 || item == 0x7f)
            {
                throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_INPUT");
            }
            if (item >= 0xd800 && item <= 0xdbff)
            {
                if (index + 1 >= input.Length ||
                    input[index + 1] < 0xdc00 ||
                    input[index + 1] > 0xdfff)
                {
                    throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_INPUT");
                }
                index++;
            }
            else if (item >= 0xdc00 && item <= 0xdfff)
            {
                throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_INPUT");
            }
        }
        if (input.StartsWith("\\\\", StringComparison.Ordinal) ||
            input.StartsWith("//", StringComparison.Ordinal))
        {
            throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_INPUT");
        }
        if (input.IndexOf('/') >= 0)
        {
            throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_INPUT");
        }
        if (input.Length < 3 ||
            !IsAsciiLetter(input[0]) ||
            input[1] != ':' ||
            input[2] != '\\')
        {
            throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_INPUT");
        }
        string drive = Char.ToUpperInvariant(input[0]) + ":\\";
        string rest = input.Substring(3);
        if (rest.Length == 0)
        {
            if (!allowDriveRoot)
            {
                throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_INPUT");
            }
            return drive;
        }
        if (rest[0] == '\\')
        {
            throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_INPUT");
        }
        string[] segments = rest.Split('\\');
        for (int index = 0; index < segments.Length; index++)
        {
            ValidateSegment(segments[index]);
        }
        return drive + String.Join("\\", segments);
    }

    private static string ValidateNonce(string value)
    {
        if (value == null || value.Length < 1 || value.Length > 128)
        {
            throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_INPUT");
        }
        for (int index = 0; index < value.Length; index++)
        {
            char item = value[index];
            if (!((item>='A'&&item<='Z')||(item>='a'&&item<='z')||(item>='0'&&item<='9')||item=='_'||item=='-'))
            {
                throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_INPUT");
            }
        }
        return value;
    }

    private static SafeFileHandle Open(string path, uint desiredAccess)
    {
        SafeFileHandle handle = CreateFileW(
            path,
            desiredAccess,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            IntPtr.Zero,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            IntPtr.Zero);
        if (handle.IsInvalid)
        {
            int error = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new Win32Exception(error);
        }
        return handle;
    }

    private static SafeFileHandle OpenRead(string path)
    {
        SafeFileHandle handle = CreateFileW(
            path,
            GENERIC_READ | FILE_READ_ATTRIBUTES | READ_CONTROL,
            FILE_SHARE_READ,
            IntPtr.Zero,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            IntPtr.Zero);
        if (handle.IsInvalid)
        {
            int error = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new Win32Exception(error);
        }
        return handle;
    }

    private static FILE_ATTRIBUTE_TAG_INFO Tag(SafeFileHandle handle)
    {
        FILE_ATTRIBUTE_TAG_INFO info;
        if (!GetFileInformationByHandleEx(
            handle,
            FileAttributeTagInfo,
            out info,
            (uint)Marshal.SizeOf(typeof(FILE_ATTRIBUTE_TAG_INFO))))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        return info;
    }

    private static bool IsReparse(SafeFileHandle handle)
    {
        FILE_ATTRIBUTE_TAG_INFO info = Tag(handle);
        return (info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 || info.ReparseTag != 0;
    }

    private static FILE_STANDARD_INFO Standard(SafeFileHandle handle)
    {
        FILE_STANDARD_INFO info;
        if (!GetFileInformationByHandleEx(
            handle,
            FileStandardInfo,
            out info,
            (uint)Marshal.SizeOf(typeof(FILE_STANDARD_INFO))))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        return info;
    }

    private static FILE_ID_INFO Identity(SafeFileHandle handle)
    {
        FILE_ID_INFO info;
        if (!GetFileInformationByHandleEx(
            handle,
            FileIdInfo,
            out info,
            (uint)Marshal.SizeOf(typeof(FILE_ID_INFO))) || info.FileId.Identifier == null)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        return info;
    }

    private static string FinalPath(SafeFileHandle handle)
    {
        StringBuilder buffer = new StringBuilder(32768);
        uint length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0);
        if (length == 0)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        if (length >= buffer.Capacity)
        {
            throw new Win32Exception(206);
        }
        string value = buffer.ToString();
        if (value.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase))
        {
            throw new Win32Exception(53);
        }
        if (value.StartsWith(@"\\?\", StringComparison.Ordinal))
        {
            value = value.Substring(4);
        }
        if (value.StartsWith(@"\??\", StringComparison.Ordinal))
        {
            value = value.Substring(4);
        }
        if (value.StartsWith(@"\\", StringComparison.Ordinal))
        {
            throw new Win32Exception(53);
        }
        return NormalizeStrict(value, true);
    }

    private static void RejectReparseAncestors(string finalPath)
    {
        string root = finalPath.Substring(0, 3);
        using (SafeFileHandle rootHandle = Open(root, FILE_READ_ATTRIBUTES | READ_CONTROL))
        {
            if (IsReparse(rootHandle))
            {
                throw new Win32Exception(4390);
            }
        }
        string remainder = finalPath.Substring(3);
        string current = root;
        string[] parts = remainder.Split(new char[] { '\\' }, StringSplitOptions.RemoveEmptyEntries);
        foreach (string part in parts)
        {
            current = current.EndsWith("\\", StringComparison.Ordinal)
                ? current + part
                : current + "\\" + part;
            using (SafeFileHandle handle = Open(current, FILE_READ_ATTRIBUTES | READ_CONTROL))
            {
                if (IsReparse(handle))
                {
                    throw new Win32Exception(4390);
                }
            }
        }
    }

    private static void ValidateVolume(SafeFileHandle handle, ulong expectedSerial)
    {
        StringBuilder filesystem = new StringBuilder(64);
        uint serial;
        uint maximumComponentLength;
        uint flags;
        if (!GetVolumeInformationByHandleW(
            handle,
            null,
            0,
            out serial,
            out maximumComponentLength,
            out flags,
            filesystem,
            (uint)filesystem.Capacity))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        if (!String.Equals(filesystem.ToString(), "NTFS", StringComparison.OrdinalIgnoreCase))
        {
            throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_VOLUME");
        }
        if ((flags & FILE_REMOTE_DEVICE) != 0)
        {
            throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_VOLUME");
        }
        if ((ulong)serial != expectedSerial)
        {
            throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_VALIDATE");
        }
    }

    private static string SidToString(IntPtr sid)
    {
        IntPtr text;
        if (!ConvertSidToStringSidW(sid, out text))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        try
        {
            return Marshal.PtrToStringUni(text);
        }
        finally
        {
            LocalFree(text);
        }
    }

    private static string Owner(SafeFileHandle handle)
    {
        IntPtr owner;
        IntPtr group;
        IntPtr dacl;
        IntPtr sacl;
        IntPtr descriptor;
        uint status = GetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            out owner,
            out group,
            out dacl,
            out sacl,
            out descriptor);
        if (status != 0)
        {
            throw new Win32Exception((int)status);
        }
        try
        {
            IntPtr ownerPointer;
            bool defaulted;
            if (!GetSecurityDescriptorOwner(descriptor, out ownerPointer, out defaulted) ||
                ownerPointer == IntPtr.Zero)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            return SidToString(ownerPointer);
        }
        finally
        {
            LocalFree(descriptor);
        }
    }

    private static bool IsNonGrantingAce(byte aceType)
    {
        switch (aceType)
        {
            case AccessDeniedAceType:
            case SystemAuditAceType:
            case SystemAlarmAceType:
            case AccessDeniedObjectAceType:
            case SystemAuditObjectAceType:
            case SystemAlarmObjectAceType:
            case AccessDeniedCallbackAceType:
            case AccessDeniedCallbackObjectAceType:
            case SystemAuditCallbackAceType:
            case SystemAlarmCallbackAceType:
            case SystemAuditCallbackObjectAceType:
            case SystemAlarmCallbackObjectAceType:
            case SystemMandatoryLabelAceType:
            case SystemResourceAttributeAceType:
            case SystemScopedPolicyIdAceType:
            case SystemProcessTrustLabelAceType:
            case SystemAccessFilterAceType:
                return true;
            default:
                return false;
        }
    }

    private static void ValidateParentDacl(SafeFileHandle handle, string currentSid)
    {
        IntPtr owner;
        IntPtr group;
        IntPtr dacl;
        IntPtr sacl;
        IntPtr descriptor;
        uint status = GetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            out owner,
            out group,
            out dacl,
            out sacl,
            out descriptor);
        if (status != 0)
        {
            throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_TRUST");
        }
        try
        {
            IntPtr daclPointer;
            bool present;
            bool defaulted;
            if (!GetSecurityDescriptorDacl(descriptor, out present, out daclPointer, out defaulted) ||
                !present || daclPointer == IntPtr.Zero)
            {
                throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_TRUST");
            }
            ACL_SIZE_INFORMATION info;
            if (!GetAclInformation(
                daclPointer,
                out info,
                (uint)Marshal.SizeOf(typeof(ACL_SIZE_INFORMATION)),
                AclSizeInformation) || info.AclBytesInUse < 8)
            {
                throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_TRUST");
            }
            HashSet<string> trusted = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            trusted.Add(currentSid);
            trusted.Add(SYSTEM_SID);
            trusted.Add(ADMIN_SID);
            for (uint index = 0; index < info.AceCount; index++)
            {
                IntPtr ace;
                if (!GetAce(daclPointer, index, out ace) || ace == IntPtr.Zero)
                {
                    throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_TRUST");
                }
                long aceOffset = ace.ToInt64() - daclPointer.ToInt64();
                if (aceOffset < 0 || aceOffset > (long)info.AclBytesInUse - 4)
                {
                    throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_TRUST");
                }
                byte aceType = Marshal.ReadByte(ace, 0);
                int aceSize = (ushort)Marshal.ReadInt16(ace, 2);
                if (aceSize < 8 || aceOffset + aceSize > (long)info.AclBytesInUse)
                {
                    throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_TRUST");
                }
                if (aceType != AccessAllowedAceType)
                {
                    if (IsNonGrantingAce(aceType))
                    {
                        continue;
                    }
                    throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_TRUST");
                }
                int sidOffset = 8;
                if (aceSize < sidOffset + 8)
                {
                    throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_TRUST");
                }
                IntPtr sidPointer = IntPtr.Add(ace, sidOffset);
                uint sidLength = GetLengthSid(sidPointer);
                if (sidLength < 8 || (long)sidOffset + sidLength > aceSize)
                {
                    throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_TRUST");
                }
                string aceSid = SidToString(sidPointer);
                uint mask = (uint)Marshal.ReadInt32(ace, 4);
                if (!trusted.Contains(aceSid) && (mask & DANGEROUS_MASK) != 0)
                {
                    throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_TRUST");
                }
            }
        }
        finally
        {
            LocalFree(descriptor);
        }
    }

    private static void ValidatePrivateDacl(SafeFileHandle handle, string currentSid)
    {
        IntPtr owner;
        IntPtr group;
        IntPtr dacl;
        IntPtr sacl;
        IntPtr descriptor;
        uint status = GetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            out owner,
            out group,
            out dacl,
            out sacl,
            out descriptor);
        if (status != 0)
        {
            throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_VALIDATE");
        }
        try
        {
            ushort control;
            uint revision;
            if (!GetSecurityDescriptorControl(descriptor, out control, out revision) ||
                (control & SE_DACL_PROTECTED) == 0)
            {
                throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_VALIDATE");
            }
            IntPtr daclPointer;
            bool present;
            bool defaulted;
            if (!GetSecurityDescriptorDacl(descriptor, out present, out daclPointer, out defaulted) ||
                !present || daclPointer == IntPtr.Zero || defaulted)
            {
                throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_VALIDATE");
            }
            ACL_SIZE_INFORMATION info;
            if (!GetAclInformation(
                daclPointer,
                out info,
                (uint)Marshal.SizeOf(typeof(ACL_SIZE_INFORMATION)),
                AclSizeInformation) || info.AclBytesInUse < 8)
            {
                throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_VALIDATE");
            }
            HashSet<string> expected = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            expected.Add(currentSid);
            if (!AsciiEqualsIgnoreCase(currentSid, SYSTEM_SID))
            {
                expected.Add(SYSTEM_SID);
            }
            HashSet<string> actual = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            for (uint index = 0; index < info.AceCount; index++)
            {
                IntPtr ace;
                if (!GetAce(daclPointer, index, out ace) || ace == IntPtr.Zero)
                {
                    throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_VALIDATE");
                }
                long aceOffset = ace.ToInt64() - daclPointer.ToInt64();
                if (aceOffset < 0 || aceOffset > (long)info.AclBytesInUse - 4)
                {
                    throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_VALIDATE");
                }
                byte aceType = Marshal.ReadByte(ace, 0);
                int aceSize = (ushort)Marshal.ReadInt16(ace, 2);
                if (aceSize < 8 || aceOffset + aceSize > (long)info.AclBytesInUse)
                {
                    throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_VALIDATE");
                }
                if (aceType != AccessAllowedAceType)
                {
                    if (IsNonGrantingAce(aceType))
                    {
                        continue;
                    }
                    throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_VALIDATE");
                }
                int sidOffset = 8;
                if (aceSize < sidOffset + 8)
                {
                    throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_VALIDATE");
                }
                IntPtr sidPointer = IntPtr.Add(ace, sidOffset);
                uint sidLength = GetLengthSid(sidPointer);
                if (sidLength < 8 || (long)sidOffset + sidLength > aceSize)
                {
                    throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_VALIDATE");
                }
                string aceSid = SidToString(sidPointer);
                uint mask = (uint)Marshal.ReadInt32(ace, 4);
                if (mask != FILE_ALL_ACCESS)
                {
                    throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_VALIDATE");
                }
                if (!expected.Contains(aceSid) || !actual.Add(aceSid))
                {
                    throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_VALIDATE");
                }
            }
            if (!actual.SetEquals(expected))
            {
                throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_VALIDATE");
            }
        }
        finally
        {
            LocalFree(descriptor);
        }
    }

    private static string HexId(FILE_ID_INFO identity)
    {
        StringBuilder value = new StringBuilder(32);
        foreach (byte item in identity.FileId.Identifier)
        {
            value.Append(item.ToString("x2"));
        }
        return value.ToString();
    }

    private static bool IsTrustedOwner(string ownerSid, string currentSid)
    {
        return AsciiEqualsIgnoreCase(ownerSid, currentSid) ||
            AsciiEqualsIgnoreCase(ownerSid, SYSTEM_SID) ||
            AsciiEqualsIgnoreCase(ownerSid, ADMIN_SID);
    }

    private static FILE_ID_INFO InspectDirectory(
        SafeFileHandle handle,
        string expectedPath,
        string currentSid,
        bool requirePrivateDacl,
        bool allowTrustedOwner)
    {
        if (IsReparse(handle))
        {
            throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_VALIDATE");
        }
        FILE_STANDARD_INFO standard = Standard(handle);
        if (standard.DeletePending || !standard.Directory || standard.NumberOfLinks == 0)
        {
            throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_VALIDATE");
        }
        FILE_ID_INFO identity = Identity(handle);
        string finalPath = FinalPath(handle);
        if (!AsciiEqualsIgnoreCase(finalPath, expectedPath))
        {
            throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_VALIDATE");
        }
        RejectReparseAncestors(finalPath);
        ValidateVolume(handle, identity.VolumeSerialNumber);
        string ownerSid = Owner(handle);
        if (allowTrustedOwner)
        {
            if (!IsTrustedOwner(ownerSid, currentSid))
            {
                throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_VALIDATE");
            }
        }
        else if (!AsciiEqualsIgnoreCase(ownerSid, currentSid))
        {
            throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_VALIDATE");
        }
        if (requirePrivateDacl)
        {
            ValidatePrivateDacl(handle, currentSid);
        }
        return identity;
    }

    private static FILE_ID_INFO InspectFile(
        SafeFileHandle handle,
        string expectedPath,
        string currentSid)
    {
        if (IsReparse(handle))
        {
            throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_VALIDATE");
        }
        FILE_STANDARD_INFO standard = Standard(handle);
        if (standard.DeletePending || standard.Directory || standard.NumberOfLinks != 1)
        {
            throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_VALIDATE");
        }
        FILE_ID_INFO identity = Identity(handle);
        string finalPath = FinalPath(handle);
        if (!AsciiEqualsIgnoreCase(finalPath, expectedPath))
        {
            throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_VALIDATE");
        }
        RejectReparseAncestors(finalPath);
        ValidateVolume(handle, identity.VolumeSerialNumber);
        string ownerSid = Owner(handle);
        if (!AsciiEqualsIgnoreCase(ownerSid, currentSid))
        {
            throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_VALIDATE");
        }
        ValidatePrivateDacl(handle, currentSid);
        return identity;
    }

    private static void RejectUnsafeParent(string parentPath)
    {
        string folded = AsciiCaseFold(parentPath);
        if (parentPath.Length == 3)
        {
            throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_TRUST");
        }
        string drive = parentPath.Substring(0, 2);
        string[] forbidden = new string[]
        {
            drive + "\\Users",
            drive + "\\Users\\Public",
            drive + "\\Windows",
            drive + "\\Program Files",
            drive + "\\Program Files (x86)",
            drive + "\\$Recycle.Bin",
            drive + "\\System Volume Information"
        };
        foreach (string item in forbidden)
        {
            if (String.Equals(folded, AsciiCaseFold(item), StringComparison.Ordinal))
            {
                throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_TRUST");
            }
        }
        string publicPrefix = AsciiCaseFold(drive + "\\Users\\Public\\");
        if (folded.StartsWith(publicPrefix, StringComparison.Ordinal))
        {
            throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_TRUST");
        }
        string profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (!String.IsNullOrEmpty(profile))
        {
            try
            {
                string normalizedProfile = NormalizeStrict(profile, true);
                if (String.Equals(folded, AsciiCaseFold(normalizedProfile), StringComparison.Ordinal))
                {
                    throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_TRUST");
                }
            }
            catch (CandidateFailure)
            {
                throw;
            }
            catch
            {
            }
        }
    }

    private static void EnsureTargetAbsent(string rootPath)
    {
        uint attributes = GetFileAttributesW(rootPath);
        if (attributes != INVALID_FILE_ATTRIBUTES)
        {
            throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_EXISTS");
        }
        int error = Marshal.GetLastWin32Error();
        if (error != ERROR_FILE_NOT_FOUND && error != ERROR_PATH_NOT_FOUND)
        {
            throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_TARGET");
        }
    }

    private static void ValidateParent(string parentPath, string currentSid)
    {
        try
        {
            using (SafeFileHandle handle = Open(parentPath, FILE_READ_ATTRIBUTES | READ_CONTROL))
            {
                InspectDirectory(handle, parentPath, currentSid, false, true);
                ValidateParentDacl(handle, currentSid);
            }
        }
        catch (CandidateFailure)
        {
            throw;
        }
        catch
        {
            throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_PARENT");
        }
        RejectUnsafeParent(parentPath);
    }

    private static void CreatePrivateDirectory(string path, string currentSid, string failureCode, ref bool created)
    {
        try
        {
            using (PrivateDirectoryDescriptor descriptor = new PrivateDirectoryDescriptor(currentSid))
            {
                SECURITY_ATTRIBUTES attributes = new SECURITY_ATTRIBUTES();
                attributes.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
                attributes.lpSecurityDescriptor = descriptor.Pointer;
                attributes.bInheritHandle = false;
                if (!CreateDirectoryW(path, ref attributes))
                {
                    int error = Marshal.GetLastWin32Error();
                    if (error == ERROR_ALREADY_EXISTS || error == ERROR_FILE_EXISTS)
                    {
                        throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_EXISTS");
                    }
                    throw new CandidateFailure(failureCode);
                }
                created = true;
            }
        }
        catch (CandidateFailure)
        {
            throw;
        }
        catch
        {
            throw new CandidateFailure(failureCode);
        }
    }

    private static void CreateOwnedRoot(string rootPath, string currentSid, ref bool created)
    {
        CreatePrivateDirectory(rootPath, currentSid, "WINDOWS_CANDIDATE_ROOT_CREATE", ref created);
    }

    private static FolioWindowsCandidateEntry[] CreateChildDirectories(string rootPath, string currentSid, ref bool created)
    {
        string[] names = new string[] { "clienta", "clientb", "server" };
        FolioWindowsCandidateEntry[] entries = new FolioWindowsCandidateEntry[names.Length];
        for (int index = 0; index < names.Length; index++)
        {
            string path = rootPath + "\\" + names[index];
            bool childCreated = false;
            CreatePrivateDirectory(path, currentSid, "WINDOWS_CANDIDATE_ROOT_CREATE", ref childCreated);
            if (!childCreated)
            {
                throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_CREATE");
            }
            entries[index] = new FolioWindowsCandidateEntry();
            entries[index].name = names[index];
            entries[index].path = path;
            entries[index].fileId = "";
            entries[index].volumeId = "";
        }
        created = true;
        return entries;
    }

    private static FILE_ID_INFO ValidateOwnedTree(
        string rootPath,
        FolioWindowsCandidateEntry[] entries,
        string currentSid)
    {
        FILE_ID_INFO rootId;
        using (SafeFileHandle handle = Open(rootPath, FILE_READ_ATTRIBUTES | READ_CONTROL))
        {
            rootId = InspectDirectory(handle, rootPath, currentSid, true, false);
        }
        HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        seen.Add(HexId(rootId));
        for (int index = 0; index < entries.Length; index++)
        {
            using (SafeFileHandle handle = Open(entries[index].path, FILE_READ_ATTRIBUTES | READ_CONTROL))
            {
                FILE_ID_INFO identity = InspectDirectory(handle, entries[index].path, currentSid, true, false);
                if (identity.VolumeSerialNumber != rootId.VolumeSerialNumber)
                {
                    throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_VALIDATE");
                }
                string fileId = HexId(identity);
                if (!seen.Add(fileId))
                {
                    throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_VALIDATE");
                }
                entries[index].fileId = fileId;
                entries[index].volumeId = identity.VolumeSerialNumber.ToString("x16");
            }
        }
        return rootId;
    }

    private static string WriteOwnershipNonce(string path, string nonce, string currentSid)
    {
        byte[] content = Encoding.ASCII.GetBytes(nonce);
        try
        {
            using (PrivateDirectoryDescriptor descriptor = new PrivateDirectoryDescriptor(currentSid))
            {
                SECURITY_ATTRIBUTES attributes = new SECURITY_ATTRIBUTES();
                attributes.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
                attributes.lpSecurityDescriptor = descriptor.Pointer;
                attributes.bInheritHandle = false;
                using (SafeFileHandle handle = CreateFileWithSecurityW(
                    path,
                    GENERIC_WRITE | FILE_READ_ATTRIBUTES | READ_CONTROL,
                    0,
                    ref attributes,
                    CREATE_NEW,
                    FILE_ATTRIBUTE_NORMAL,
                    IntPtr.Zero))
                {
                    if (handle.IsInvalid)
                    {
                        throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_NONCE");
                    }
                    uint written;
                    if (!WriteFile(handle, content, (uint)content.Length, out written, IntPtr.Zero) ||
                        written != (uint)content.Length)
                    {
                        throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_NONCE");
                    }
                    if (!FlushFileBuffers(handle))
                    {
                        throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_NONCE");
                    }
                }
            }
        }
        catch (CandidateFailure)
        {
            throw;
        }
        catch
        {
            throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_NONCE");
        }
        using (SafeFileHandle handle = OpenRead(path))
        {
            FILE_ID_INFO identity = InspectFile(handle, path, currentSid);
            return HexId(identity);
        }
    }

    private static void ValidateOwnershipNonce(
        string path,
        string expectedFileId,
        string nonce,
        string currentSid,
        FILE_ID_INFO rootId)
    {
        byte[] expected = Encoding.ASCII.GetBytes(nonce);
        using (SafeFileHandle handle = OpenRead(path))
        {
            FILE_ID_INFO identity = InspectFile(handle, path, currentSid);
            if (!AsciiEqualsIgnoreCase(HexId(identity), expectedFileId) ||
                identity.VolumeSerialNumber != rootId.VolumeSerialNumber)
            {
                throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_VALIDATE");
            }
            FILE_STANDARD_INFO standard = Standard(handle);
            if (standard.EndOfFile != (long)expected.Length)
            {
                throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_VALIDATE");
            }
            byte[] actual = new byte[expected.Length];
            uint read;
            if (!ReadFile(handle, actual, (uint)actual.Length, out read, IntPtr.Zero) ||
                read != (uint)actual.Length)
            {
                throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_VALIDATE");
            }
            for (int index = 0; index < expected.Length; index++)
            {
                if (actual[index] != expected[index])
                {
                    throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_VALIDATE");
                }
            }
        }
    }

    private static FolioWindowsCandidateResult Success(
        string rootPath,
        string nonce,
        string currentSid,
        FILE_ID_INFO rootId,
        string ownershipPath,
        string ownershipFileId,
        FolioWindowsCandidateEntry[] entries)
    {
        FolioWindowsCandidateResult result = new FolioWindowsCandidateResult();
        result.candidate = true;
        result.created = true;
        result.code = "WINDOWS_CANDIDATE_ROOT_READY";
        result.root = rootPath;
        result.nonce = nonce;
        result.ownerSid = currentSid;
        result.volumeId = rootId.VolumeSerialNumber.ToString("x16");
        result.rootFileId = HexId(rootId);
        result.ownershipPath = ownershipPath;
        result.ownershipFileId = ownershipFileId;
        result.directories = entries;
        return result;
    }

    private static FolioWindowsCandidateResult Failure(
        string code,
        bool created,
        string rootPath,
        string nonce,
        string currentSid)
    {
        FolioWindowsCandidateResult result = new FolioWindowsCandidateResult();
        result.candidate = false;
        result.created = created;
        result.code = code;
        result.root = rootPath;
        result.nonce = nonce;
        result.ownerSid = currentSid == null ? "" : currentSid;
        result.volumeId = "";
        result.rootFileId = "";
        result.ownershipPath = "";
        result.ownershipFileId = "";
        result.directories = new FolioWindowsCandidateEntry[0];
        return result;
    }

    public static FolioWindowsCandidateResult Run(string rootInput, string nonceInput, string currentSid)
    {
        bool created = false;
        string rootPath = rootInput;
        string nonce = nonceInput;
        try
        {
            nonce = ValidateNonce(nonceInput);
            if (String.IsNullOrEmpty(currentSid) || currentSid.Length > 184)
            {
                throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_IDENTITY");
            }
            rootPath = NormalizeStrict(rootInput, false);
            string parentPath = System.IO.Path.GetDirectoryName(rootPath);
            if (String.IsNullOrEmpty(parentPath))
            {
                throw new CandidateFailure("WINDOWS_CANDIDATE_ROOT_INPUT");
            }
            parentPath = NormalizeStrict(parentPath, true);
            EnsureTargetAbsent(rootPath);
            ValidateParent(parentPath, currentSid);
            CreateOwnedRoot(rootPath, currentSid, ref created);
            FolioWindowsCandidateEntry[] entries = CreateChildDirectories(rootPath, currentSid, ref created);
            FILE_ID_INFO rootId = ValidateOwnedTree(rootPath, entries, currentSid);
            string ownershipPath = rootPath + "\\ownership.nonce";
            string ownershipFileId = WriteOwnershipNonce(ownershipPath, nonce, currentSid);
            ValidateOwnershipNonce(ownershipPath, ownershipFileId, nonce, currentSid, rootId);
            return Success(rootPath, nonce, currentSid, rootId, ownershipPath, ownershipFileId, entries);
        }
        catch (CandidateFailure failure)
        {
            return Failure(failure.Code, created, rootPath, nonce, currentSid);
        }
        catch
        {
            return Failure("WINDOWS_CANDIDATE_ROOT_FAILED", created, rootPath, nonce, currentSid);
        }
    }
}
'@

    $result = [FolioWindowsCandidateRoot]::Run($Root, $Nonce, $sid)
    Write-CandidateResult -Result $result
    if ($result.candidate -eq $true -and $result.code -eq 'WINDOWS_CANDIDATE_ROOT_READY') {
        exit 0
    }
    exit 1
}
catch {
    $code = 'WINDOWS_CANDIDATE_ROOT_FAILED'
    if ($_.Exception -is [System.Management.Automation.RuntimeException] -and
        $_.Exception.Message -match '^WINDOWS_CANDIDATE_ROOT_[A-Z_]+$') {
        $code = $_.Exception.Message
    }
    $failure = [ordered]@{
        candidate       = $false
        code            = $code
        created         = $false
        directories     = @()
        nonce           = [string]$Nonce
        ownerSid        = ''
        ownershipFileId = ''
        ownershipPath   = ''
        physical        = 'NOT_RUN'
        root            = [string]$Root
        rootFileId      = ''
        volumeId        = ''
    }
    [Console]::Out.Write(($failure | ConvertTo-Json -Compress -Depth 4))
    exit 1
}
