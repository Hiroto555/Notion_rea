[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$Path,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$Root
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        throw 'WINDOWS_PRIVATE_ROOT_PLATFORM'
    }

    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    if ($null -eq $identity -or $null -eq $identity.User) {
        throw 'WINDOWS_PRIVATE_ROOT_IDENTITY'
    }
    $sid = $identity.User.Value
    if ([string]::IsNullOrWhiteSpace($sid)) {
        throw 'WINDOWS_PRIVATE_ROOT_IDENTITY'
    }

    Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public sealed class FolioWindowsProbeResult
{
    public bool daclPrivate { get; set; }
    public string fileId { get; set; }
    public string rootFileId { get; set; }
    public int linkCount { get; set; }
    public bool localFilesystem { get; set; }
    public string ownerSid { get; set; }
    public bool reparsePoint { get; set; }
    public string volumeId { get; set; }
    public string rootVolumeId { get; set; }
    public string canonicalPath { get; set; }
    public string canonicalRoot { get; set; }
}

public static class FolioWindowsProbe
{
    private const uint FILE_READ_ATTRIBUTES = 0x00000080;
    private const uint READ_CONTROL = 0x00020000;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint FILE_SHARE_DELETE = 0x00000004;
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
    private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
    private const int FileStandardInfo = 1;
    private const int FileAttributeTagInfo = 9;
    private const int FileIdInfo = 18;
    private const uint SE_FILE_OBJECT = 1;
    private const uint OWNER_SECURITY_INFORMATION = 0x00000001;
    private const uint DACL_SECURITY_INFORMATION = 0x00000004;
    private const int AclSizeInformation = 2;
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
    private const uint FILE_REMOTE_DEVICE = 0x00000001;

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
    private static extern SafeFileHandle CreateFileW(
        string lpFileName,
        uint dwDesiredAccess,
        uint dwShareMode,
        IntPtr lpSecurityAttributes,
        uint dwCreationDisposition,
        uint dwFlagsAndAttributes,
        IntPtr hTemplateFile);

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
    private static extern bool ConvertSidToStringSidW(
        IntPtr Sid,
        out IntPtr StringSid);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr hMem);

    private static readonly HashSet<string> UnsafeSids =
        new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "S-1-1-0",
            "S-1-5-2",
            "S-1-5-4",
            "S-1-5-7",
            "S-1-5-11",
            "S-1-5-32-545",
            "S-1-5-32-546",
            "S-1-5-32-547",
            "S-1-5-32-555",
            "S-1-15-2-1",
            "S-1-15-2-2"
        };

    private static SafeFileHandle Open(string path, bool noFollow)
    {
        uint flags = FILE_FLAG_BACKUP_SEMANTICS |
            (noFollow ? FILE_FLAG_OPEN_REPARSE_POINT : 0);
        SafeFileHandle handle = CreateFileW(
            path,
            FILE_READ_ATTRIBUTES | READ_CONTROL,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            IntPtr.Zero,
            OPEN_EXISTING,
            flags,
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
        return (info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 ||
            info.ReparseTag != 0;
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
            (uint)Marshal.SizeOf(typeof(FILE_ID_INFO))))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        if (info.FileId.Identifier == null)
        {
            throw new Win32Exception(87);
        }
        return info;
    }

    private static string Normalize(string path)
    {
        if (string.IsNullOrEmpty(path))
        {
            throw new Win32Exception(87);
        }
        string root = System.IO.Path.GetPathRoot(path);
        if (string.IsNullOrEmpty(root) || root.Length != 3)
        {
            throw new Win32Exception(87);
        }
        string result = System.IO.Path.GetFullPath(path);
        if (result.Length > root.Length &&
            result.EndsWith(@"\", StringComparison.Ordinal))
        {
            result = result.Substring(0, result.Length - 1);
        }
        return result;
    }

    private static string FinalPath(SafeFileHandle handle)
    {
        StringBuilder buffer = new StringBuilder(32768);
        uint length = GetFinalPathNameByHandleW(
            handle,
            buffer,
            (uint)buffer.Capacity,
            0);
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
        return Normalize(value);
    }

    private static bool AsciiEqualsIgnoreCase(string left, string right)
    {
        if (left == null || right == null || left.Length != right.Length)
        {
            return false;
        }
        for (int index = 0; index < left.Length; index++)
        {
            char a = left[index];
            char b = right[index];
            if (a == b)
            {
                continue;
            }
            if (a >= 'A' && a <= 'Z')
            {
                a = (char)(a + 32);
            }
            if (b >= 'A' && b <= 'Z')
            {
                b = (char)(b + 32);
            }
            if (a != b)
            {
                return false;
            }
        }
        return true;
    }

    private static void RejectReparseAncestors(string finalPath)
    {
        string root = System.IO.Path.GetPathRoot(finalPath);
        if (string.IsNullOrEmpty(root))
        {
            throw new Win32Exception(87);
        }
        using (SafeFileHandle rootHandle = Open(root, true))
        {
            if (IsReparse(rootHandle))
            {
                throw new Win32Exception(4390);
            }
        }
        string current = root;
        string remainder = finalPath.Substring(root.Length);
        foreach (string part in remainder.Split(
            new[] { '\\' },
            StringSplitOptions.RemoveEmptyEntries))
        {
            current = System.IO.Path.Combine(current, part);
            using (SafeFileHandle handle = Open(current, true))
            {
                if (IsReparse(handle))
                {
                    throw new Win32Exception(4390);
                }
            }
        }
    }

    private static void ValidateLocalVolume(SafeFileHandle handle, ulong expectedSerial)
    {
        StringBuilder filesystem = new StringBuilder(256);
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
        if (filesystem.Length == 0)
        {
            throw new Win32Exception(87);
        }
        if ((flags & FILE_REMOTE_DEVICE) != 0)
        {
            throw new Win32Exception(53);
        }
        if ((ulong)serial != expectedSerial)
        {
            throw new Win32Exception(4390);
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
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
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
            IntPtr ownerPtr;
            bool defaulted;
            if (!GetSecurityDescriptorOwner(
                descriptor,
                out ownerPtr,
                out defaulted) || ownerPtr == IntPtr.Zero)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            return SidToString(ownerPtr);
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

    private static bool PrivateDacl(
        SafeFileHandle handle,
        string ownerSid,
        string currentSid)
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
            throw new Win32Exception((int)status);
        }
        try
        {
            IntPtr daclPtr;
            bool present;
            bool defaulted;
            if (!GetSecurityDescriptorDacl(
                descriptor,
                out present,
                out daclPtr,
                out defaulted))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            if (!present || daclPtr == IntPtr.Zero)
            {
                return false;
            }

            ACL_SIZE_INFORMATION info;
            if (!GetAclInformation(
                daclPtr,
                out info,
                (uint)Marshal.SizeOf(typeof(ACL_SIZE_INFORMATION)),
                AclSizeInformation))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            if (info.AclBytesInUse < 8)
            {
                return false;
            }

            HashSet<string> allowed =
                new HashSet<string>(StringComparer.OrdinalIgnoreCase)
                {
                    ownerSid,
                    currentSid,
                    "S-1-5-18",
                    "S-1-5-32-544"
                };

            for (uint index = 0; index < info.AceCount; index++)
            {
                IntPtr ace;
                if (!GetAce(daclPtr, index, out ace) || ace == IntPtr.Zero)
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
                long aceOffset = ace.ToInt64() - daclPtr.ToInt64();
                if (aceOffset < 0 || aceOffset > (long)info.AclBytesInUse - 4)
                {
                    return false;
                }
                byte aceType = Marshal.ReadByte(ace, 0);
                int aceSize = (ushort)Marshal.ReadInt16(ace, 2);
                if (aceSize < 8 || aceOffset + aceSize > (long)info.AclBytesInUse)
                {
                    return false;
                }
                if (aceType == AccessAllowedCompoundAceType ||
                    aceType == AccessAllowedObjectAceType ||
                    aceType == AccessDeniedObjectAceType ||
                    aceType == SystemAuditObjectAceType ||
                    aceType == SystemAlarmObjectAceType ||
                    aceType == AccessAllowedCallbackAceType ||
                    aceType == AccessAllowedCallbackObjectAceType ||
                    aceType == AccessDeniedCallbackObjectAceType ||
                    aceType == SystemAuditCallbackObjectAceType ||
                    aceType == SystemAlarmCallbackObjectAceType)
                {
                    return false;
                }
                if (aceType != AccessAllowedAceType)
                {
                    if (IsNonGrantingAce(aceType))
                    {
                        continue;
                    }
                    return false;
                }
                int sidOffset = 8;
                if (aceSize < sidOffset + 8)
                {
                    return false;
                }
                IntPtr sidPtr = IntPtr.Add(ace, sidOffset);
                uint sidLength = GetLengthSid(sidPtr);
                if (sidLength < 8 || (long)sidOffset + sidLength > aceSize)
                {
                    return false;
                }
                string aceSid = SidToString(sidPtr);
                if (UnsafeSids.Contains(aceSid))
                {
                    return false;
                }
                if (!allowed.Contains(aceSid))
                {
                    return false;
                }
            }
            return true;
        }
        finally
        {
            LocalFree(descriptor);
        }
    }

    private static FILE_ID_INFO InspectHandle(
        SafeFileHandle handle,
        string expectedPath,
        string currentSid,
        bool requireSingleLink,
        out string finalPath,
        out uint linkCount)
    {
        if (IsReparse(handle))
        {
            throw new Win32Exception(4390);
        }
        FILE_STANDARD_INFO standard = Standard(handle);
        if (standard.DeletePending)
        {
            throw new Win32Exception(4390);
        }
        if (requireSingleLink && standard.NumberOfLinks != 1)
        {
            throw new Win32Exception(4390);
        }
        FILE_ID_INFO identity = Identity(handle);
        finalPath = FinalPath(handle);
        if (!AsciiEqualsIgnoreCase(finalPath, expectedPath))
        {
            throw new Win32Exception(4390);
        }
        ValidateLocalVolume(handle, identity.VolumeSerialNumber);
        string owner = Owner(handle);
        if (!AsciiEqualsIgnoreCase(owner, currentSid))
        {
            throw new Win32Exception(4390);
        }
        if (!PrivateDacl(handle, owner, currentSid))
        {
            throw new Win32Exception(4390);
        }
        linkCount = standard.NumberOfLinks;
        return identity;
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

    public static FolioWindowsProbeResult Run(
        string target,
        string root,
        string currentSid)
    {
        string expectedTarget = Normalize(System.IO.Path.GetFullPath(target));
        string expectedRoot = Normalize(System.IO.Path.GetFullPath(root));

        using (SafeFileHandle targetHandle = Open(expectedTarget, true))
        using (SafeFileHandle rootHandle = Open(expectedRoot, true))
        {
            string finalTarget;
            string finalRoot;
            uint linkCount;
            uint rootLinkCount;
            FILE_ID_INFO targetId = InspectHandle(
                targetHandle,
                expectedTarget,
                currentSid,
                true,
                out finalTarget,
                out linkCount);
            FILE_ID_INFO rootId = InspectHandle(
                rootHandle,
                expectedRoot,
                currentSid,
                false,
                out finalRoot,
                out rootLinkCount);

            RejectReparseAncestors(finalTarget);
            RejectReparseAncestors(finalRoot);

            if (rootLinkCount == 0)
            {
                throw new Win32Exception(87);
            }
            if (targetId.VolumeSerialNumber != rootId.VolumeSerialNumber)
            {
                throw new Win32Exception(4390);
            }
            string rootPrefix = finalRoot.EndsWith(@"\", StringComparison.Ordinal)
                ? finalRoot
                : finalRoot + @"\";
            if (!String.Equals(finalTarget, finalRoot, StringComparison.Ordinal) &&
                !finalTarget.StartsWith(rootPrefix, StringComparison.Ordinal))
            {
                throw new Win32Exception(4390);
            }

            return new FolioWindowsProbeResult
            {
                daclPrivate = true,
                fileId = HexId(targetId),
                rootFileId = HexId(rootId),
                linkCount = (int)linkCount,
                localFilesystem = true,
                ownerSid = currentSid,
                reparsePoint = false,
                volumeId = targetId.VolumeSerialNumber.ToString("x16"),
                rootVolumeId = rootId.VolumeSerialNumber.ToString("x16"),
                canonicalPath = finalTarget,
                canonicalRoot = finalRoot
            };
        }
    }
}
'@

    $probe = [FolioWindowsProbe]::Run($Path, $Root, $sid)
    $output = [ordered]@{
        canonicalPath   = [string]$probe.canonicalPath
        canonicalRoot   = [string]$probe.canonicalRoot
        daclPrivate     = [bool]$probe.daclPrivate
        fileId          = [string]$probe.fileId
        linkCount       = [int]$probe.linkCount
        localFilesystem = [bool]$probe.localFilesystem
        ownerSid        = [string]$probe.ownerSid
        platform        = 'win32'
        reparsePoint    = [bool]$probe.reparsePoint
        rootFileId      = [string]$probe.rootFileId
        rootVolumeId    = [string]$probe.rootVolumeId
        sid             = [string]$sid
        volumeId        = [string]$probe.volumeId
    }

    if ([string]::IsNullOrWhiteSpace($output.canonicalPath) -or
        [string]::IsNullOrWhiteSpace($output.canonicalRoot) -or
        [string]::IsNullOrWhiteSpace($output.fileId) -or
        [string]::IsNullOrWhiteSpace($output.rootFileId) -or
        [string]::IsNullOrWhiteSpace($output.volumeId) -or
        [string]::IsNullOrWhiteSpace($output.rootVolumeId) -or
        [string]::IsNullOrWhiteSpace($output.ownerSid) -or
        [string]::IsNullOrWhiteSpace($output.sid)) {
        throw 'WINDOWS_PRIVATE_ROOT_OUTPUT'
    }
    if ($output.daclPrivate -ne $true -or
        $output.linkCount -ne 1 -or
        $output.localFilesystem -ne $true -or
        $output.ownerSid -ne $output.sid -or
        $output.platform -ne 'win32' -or
        $output.reparsePoint -ne $false -or
        $output.volumeId -ne $output.rootVolumeId) {
        throw 'WINDOWS_PRIVATE_ROOT_UNSAFE'
    }

    [Console]::Out.Write(($output | ConvertTo-Json -Compress))
    exit 0
}
catch {
    [Console]::Error.WriteLine('WINDOWS_PRIVATE_ROOT_UNSAFE')
    exit 1
}
