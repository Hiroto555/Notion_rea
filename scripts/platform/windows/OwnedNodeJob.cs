using System.Runtime.Versioning;
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

[SupportedOSPlatform("windows")]
internal static class OwnedNodeJob
{
    private const int MaxCapturedBytes = 64 * 1024;
    private const int MaxResultBytes = 64 * 1024;
    private const int MinTimeoutMs = 1;
    private const int MaxTimeoutMs = 300_000;
    private const uint CreateSuspended = 0x00000004;
    private const uint CreateUnicodeEnvironment = 0x00000400;
    private const uint ExtendedStartupInfoPresent = 0x00080000;
    private const uint CreateNoWindow = 0x08000000;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const uint JobObjectLimitActiveProcess = 0x00000008;
    private const int JobObjectBasicAccountingInformation = 1;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint StartfUseStdHandles = 0x00000100;
    private const uint HandleFlagInherit = 0x00000001;
    private const uint WaitObject0 = 0;
    private const uint WaitTimeout = 258;
    private const uint CtrlCloseEvent = 2;
    private const uint CtrlLogoffEvent = 5;
    private const uint CtrlShutdownEvent = 6;
    private const uint ProcThreadAttributeHandleList = 0x00020002;

    private const uint FileShareRead = 0x00000001;
    private const uint FileShareWrite = 0x00000002;
    private const uint FileReadAttributes = 0x00000080;
    private const uint ReadControl = 0x00020000;
    private const uint OpenExisting = 3;
    private const uint FileFlagBackupSemantics = 0x02000000;
    private const uint FileFlagOpenReparsePoint = 0x00200000;
    private const uint FileAttributeDirectory = 0x00000010;
    private const uint FileAttributeDevice = 0x00000040;
    private const uint FileAttributeReparsePoint = 0x00000400;
    private const int FileAttributeTagInfoClass = 9;
    private const int SeFileObject = 1;
    private const uint OwnerSecurityInformation = 0x00000001;
    private const uint DaclSecurityInformation = 0x00000004;
    private const uint SddlRevision1 = 1;
    private const uint DriveFixed = 3;
    private const int ReapDeadlineMs = 5_000;

    private static readonly object JobGate = new object();
    private static IntPtr activeJob;

    private static readonly HandlerRoutine ControlHandler = OnControl;

    private sealed class Reject : Exception
    {
        public Reject(string code) : base(code) { Code = code; }
        public string Code { get; }
    }

    private sealed class Args
    {
        public string NodeExe = "";
        public string OwnedScript = "";
        public string TempRoot = "";
        public string Nonce = "";
        public int TimeoutMs;
    }

    private sealed class Inspected
    {
        public SafeFileHandle Handle = null;
    }

    private sealed class Capture
    {
        private readonly object gate = new object();
        private readonly MemoryStream kept = new MemoryStream();
        private long total;

        public void Append(byte[] buffer, int count)
        {
            lock (gate)
            {
                total += count;
                int room = MaxCapturedBytes - (int)kept.Length;
                if (room > 0)
                {
                    int take = Math.Min(room, count);
                    kept.Write(buffer, 0, take);
                }
            }
        }

        public Snapshot Read()
        {
            lock (gate)
            {
                return new Snapshot((int)kept.Length, total > MaxCapturedBytes);
            }
        }
    }

    private readonly struct Snapshot
    {
        public Snapshot(int bytes, bool truncated)
        {
            Bytes = bytes;
            Truncated = truncated;
        }

        public int Bytes { get; }
        public bool Truncated { get; }
    }

    private static async Task<int> Main(string[] rawArgs)
    {
        try
        {
            Args args = ParseAndValidate(rawArgs);
            return await Run(args).ConfigureAwait(false);
        }
        catch (Reject rejected)
        {
            Console.Error.WriteLine(rejected.Code);
            return 2;
        }
        catch
        {
            Console.Error.WriteLine("INTERNAL");
            return 3;
        }
    }

    private static Args ParseAndValidate(string[] rawArgs)
    {
        if (rawArgs.Length != 5) throw new Reject("ARG_COUNT");

        var args = new Args
        {
            NodeExe = CanonicalRegularFile(rawArgs[0], "NODE_EXE"),
            OwnedScript = CanonicalRegularFile(rawArgs[1], "OWNED_SCRIPT"),
            TempRoot = CanonicalDirectory(rawArgs[2]),
            Nonce = rawArgs[3],
        };

        if (!Regex.IsMatch(args.Nonce, "\\A[A-Za-z0-9_-]{1,128}\\z", RegexOptions.CultureInvariant)) throw new Reject("NONCE");
        if (!int.TryParse(rawArgs[4], NumberStyles.None, CultureInfo.InvariantCulture, out int timeout) || timeout < MinTimeoutMs || timeout > MaxTimeoutMs) throw new Reject("TIMEOUT");
        args.TimeoutMs = timeout;

        string relative = Path.GetRelativePath(args.TempRoot, args.OwnedScript);
        if (Path.IsPathRooted(relative) || relative == ".." || relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal)) throw new Reject("SCRIPT_OUTSIDE_ROOT");

        return args;
    }

    private static string CanonicalDirectory(string input)
    {
        string canonical = CanonicalAbsolute(input, "TEMP_ROOT");
        DirectoryInfo info = new DirectoryInfo(canonical);
        if (!info.Exists) throw new Reject("TEMP_ROOT_MISSING");
        if ((info.Attributes & (FileAttributes.ReparsePoint | FileAttributes.Device)) != 0) throw new Reject("TEMP_ROOT_NOT_REGULAR");
        return canonical;
    }

    private static string CanonicalRegularFile(string input, string label)
    {
        string canonical = CanonicalAbsolute(input, label);
        FileInfo info = new FileInfo(canonical);
        if (!info.Exists) throw new Reject(label + "_MISSING");
        if ((info.Attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint | FileAttributes.Device)) != 0) throw new Reject(label + "_NOT_REGULAR");
        return canonical;
    }

    private static string CanonicalAbsolute(string input, string label)
    {
        if (string.IsNullOrEmpty(input)) throw new Reject(label + "_EMPTY");
        if (!IsWellFormed(input)) throw new Reject(label + "_UNICODE");
        for (int index = 0; index < input.Length; index++)
        {
            char value = input[index];
            if (value < 0x20 || value == 0x7f) throw new Reject(label + "_CONTROL");
        }
        if (input.StartsWith(@"\\", StringComparison.Ordinal) || input.StartsWith("//", StringComparison.Ordinal)) throw new Reject(label + "_UNC");
        if (input.Length < 3 || !char.IsLetter(input[0]) || input[1] != ':' || (input[2] != '\\' && input[2] != '/')) throw new Reject(label + "_NOT_ABSOLUTE");
        string rest = input.Substring(3);
        if (rest.Length > 0 && (rest[0] == '\\' || rest[0] == '/')) throw new Reject(label + "_REPEATED_SEPARATOR");
        if (rest.IndexOf("\\\\", StringComparison.Ordinal) >= 0 || rest.IndexOf("//", StringComparison.Ordinal) >= 0 || rest.IndexOf("\\/", StringComparison.Ordinal) >= 0 || rest.IndexOf("/\\", StringComparison.Ordinal) >= 0) throw new Reject(label + "_REPEATED_SEPARATOR");
        string withoutTrailing = rest.Length > 0 && (rest[rest.Length - 1] == '\\' || rest[rest.Length - 1] == '/') ? rest.Substring(0, rest.Length - 1) : rest;
        string[] segments = withoutTrailing.Length == 0 ? Array.Empty<string>() : withoutTrailing.Split('\\', '/');
        foreach (string segment in segments) ValidateSegment(segment, label);
        try
        {
            return Path.GetFullPath(input);
        }
        catch (Exception exception) when (exception is ArgumentException || exception is NotSupportedException || exception is PathTooLongException)
        {
            throw new Reject(label + "_INVALID");
        }
    }

    private static void ValidateSegment(string segment, string label)
    {
        if (segment.Length == 0) throw new Reject(label + "_EMPTY_SEGMENT");
        if (segment == "." || segment == "..") throw new Reject(label + "_TRAVERSAL");
        foreach (char value in segment)
        {
            if (value < 0x20 || value == 0x7f) throw new Reject(label + "_CONTROL");
        }
        if (segment.IndexOf(':') >= 0) throw new Reject(label + "_ADS");
        if (segment.IndexOfAny(new[] { '<', '>', '"', '|', '?', '*' }) >= 0) throw new Reject(label + "_ILLEGAL_CHAR");
        if (segment.EndsWith(" ", StringComparison.Ordinal) || segment.EndsWith(".", StringComparison.Ordinal)) throw new Reject(label + "_TRAILING");
        if (Regex.IsMatch(segment, "~[0-9]", RegexOptions.CultureInvariant)) throw new Reject(label + "_SHORT_NAME");
        string stem = segment.Split('.')[0].ToUpperInvariant();
        if (IsReserved(stem)) throw new Reject(label + "_RESERVED");
    }

    private static bool IsReserved(string stem)
    {
        switch (stem)
        {
            case "CON":
            case "PRN":
            case "AUX":
            case "NUL":
            case "CLOCK$":
            case "CONIN$":
            case "CONOUT$":
                return true;
        }
        if (stem.Length == 4)
        {
            string prefix = stem.Substring(0, 3);
            char suffix = stem[3];
            return (prefix == "COM" || prefix == "LPT") && suffix >= '1' && suffix <= '9';
        }
        return false;
    }

    private static bool IsWellFormed(string value)
    {
        for (int index = 0; index < value.Length; index++)
        {
            char current = value[index];
            if (current >= 0xd800 && current <= 0xdbff)
            {
                if (++index >= value.Length) return false;
                char next = value[index];
                if (next < 0xdc00 || next > 0xdfff) return false;
            }
            else if (current >= 0xdc00 && current <= 0xdfff)
            {
                return false;
            }
        }
        return true;
    }

    private static async Task<int> Run(Args args)
    {
        Inspected root = null;
        Inspected script = null;
        Inspected node = null;
        try
        {
            root = Inspect(args.TempRoot, "TEMP_ROOT", true, true);
            script = Inspect(args.OwnedScript, "OWNED_SCRIPT", false, true);
            node = Inspect(args.NodeExe, "NODE_EXE", false, false);
        }
        catch
        {
            DisposeInspected(root, script, node);
            throw;
        }

        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
        {
            DisposeInspected(root, script, node);
            throw new Reject("JOB_CREATE");
        }
        bool handlerInstalled = false;
        IntPtr process = IntPtr.Zero;
        IntPtr thread = IntPtr.Zero;
        IntPtr attributeList = IntPtr.Zero;
        bool attributeInitialized=false;
        SafeFileHandle stdinRead = null, stdinWrite = null, stdoutRead = null, stdoutWrite = null, stderrRead = null, stderrWrite = null;
        FileStream stdoutStream = null, stderrStream = null;
        Task stdoutTask = null, stderrTask = null;
        GCHandle environmentPin = default;
        bool environmentPinned = false;
        try
        {
            var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose | JobObjectLimitActiveProcess;
            limits.BasicLimitInformation.ActiveProcessLimit = 8; // Owned probe/helper descendants remain bounded in this job.
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits, (uint)Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>()))
            {
                throw new Reject("JOB_LIMIT");
            }

            var attributes = new SECURITY_ATTRIBUTES
            {
                nLength = Marshal.SizeOf<SECURITY_ATTRIBUTES>(),
                bInheritHandle = true,
                lpSecurityDescriptor = IntPtr.Zero,
            };
            if (!CreatePipe(out stdinRead, out stdinWrite, ref attributes, 0)) throw new Reject("PIPE");
            if (!CreatePipe(out stdoutRead, out stdoutWrite, ref attributes, 0)) throw new Reject("PIPE");
            if (!CreatePipe(out stderrRead, out stderrWrite, ref attributes, 0)) throw new Reject("PIPE");
            if (!SetHandleInformation(stdinRead.DangerousGetHandle(), HandleFlagInherit, HandleFlagInherit)) throw new Reject("PIPE_INHERIT");
            if (!SetHandleInformation(stdoutWrite.DangerousGetHandle(), HandleFlagInherit, HandleFlagInherit)) throw new Reject("PIPE_INHERIT");
            if (!SetHandleInformation(stderrWrite.DangerousGetHandle(), HandleFlagInherit, HandleFlagInherit)) throw new Reject("PIPE_INHERIT");
            if (!SetHandleInformation(stdinWrite.DangerousGetHandle(), HandleFlagInherit, 0)) throw new Reject("PIPE_INHERIT");
            if (!SetHandleInformation(stdoutRead.DangerousGetHandle(), HandleFlagInherit, 0)) throw new Reject("PIPE_INHERIT");
            if (!SetHandleInformation(stderrRead.DangerousGetHandle(), HandleFlagInherit, 0)) throw new Reject("PIPE_INHERIT");

            IntPtr[] inherited = { stdinRead.DangerousGetHandle(), stdoutWrite.DangerousGetHandle(), stderrWrite.DangerousGetHandle() };
            GCHandle inheritedPin = GCHandle.Alloc(inherited, GCHandleType.Pinned);
            IntPtr attributeSize = IntPtr.Zero;
            try
            {
                InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeSize);
                attributeList = Marshal.AllocHGlobal(attributeSize);
                if (!InitializeProcThreadAttributeList(attributeList, 1, 0, ref attributeSize)) throw new Reject("STARTUP_ATTRIBUTES");
                attributeInitialized=true;
                if (!UpdateProcThreadAttribute(attributeList, 0, (IntPtr)ProcThreadAttributeHandleList, inheritedPin.AddrOfPinnedObject(), (UIntPtr)((uint)IntPtr.Size * (uint)inherited.Length), IntPtr.Zero, IntPtr.Zero))
                {
                    throw new Reject("STARTUP_HANDLE_LIST");
                }
            }
            finally
            {
                inheritedPin.Free();
            }

            var startup = new STARTUPINFOEX
            {
                StartupInfo = new STARTUPINFO
                {
                    cb = Marshal.SizeOf<STARTUPINFOEX>(),
                    dwFlags = StartfUseStdHandles,
                    hStdInput = stdinRead.DangerousGetHandle(),
                    hStdOutput = stdoutWrite.DangerousGetHandle(),
                    hStdError = stderrWrite.DangerousGetHandle(),
                },
                lpAttributeList = attributeList,
            };
            string commandLine = Quote(args.NodeExe) + " " + Quote(args.OwnedScript);
            var mutableCommandLine = new StringBuilder(commandLine, commandLine.Length + 1);

            IntPtr environment = BuildEnvironment(args.TempRoot, out environmentPin);
            environmentPinned = true;

            ActivateJob(job);
            if (!SetConsoleCtrlHandler(ControlHandler, true)) throw new Reject("CTRL_HANDLER");
            handlerInstalled = true;

            uint creationFlags = CreateSuspended | CreateUnicodeEnvironment | CreateNoWindow | ExtendedStartupInfoPresent;
            if (!CreateProcess(args.NodeExe, mutableCommandLine, IntPtr.Zero, IntPtr.Zero, true, creationFlags, environment, args.TempRoot, ref startup, out PROCESS_INFORMATION processInfo))
            {
                throw new Reject("PROCESS_CREATE");
            }
            process = processInfo.hProcess;
            thread = processInfo.hThread;

            stdinWrite.Dispose();
            stdinWrite = null;
            stdinRead.Dispose();
            stdinRead = null;
            stdoutWrite.Dispose();
            stdoutWrite = null;
            stderrWrite.Dispose();
            stderrWrite = null;

            stdoutStream = new FileStream(stdoutRead, FileAccess.Read, 4096, false);
            stderrStream = new FileStream(stderrRead, FileAccess.Read, 4096, false);
            var stdoutCapture = new Capture();
            var stderrCapture = new Capture();
            stdoutTask = ReadBounded(stdoutStream, stdoutCapture);
            stderrTask = ReadBounded(stderrStream, stderrCapture);

            if (!AssignProcessToJobObject(job, process))
            {
                TerminateProcess(process, 1);
                WaitForSingleObject(process, ReapDeadlineMs);
                throw new Reject("JOB_ASSIGN");
            }

            if (ResumeThread(thread) == uint.MaxValue)
            {
                TerminateJobObject(job, 1);
                throw new Reject("PROCESS_RESUME");
            }
            CloseHandle(thread);
            thread = IntPtr.Zero;

            uint wait = WaitForSingleObject(process, (uint)args.TimeoutMs);
            bool timedOut = wait == WaitTimeout;
            bool exited = wait == WaitObject0;
            if (timedOut || !exited)
            {
                TerminateJobObject(job, 1);
                exited = WaitForSingleObject(process, ReapDeadlineMs) == WaitObject0;
            }

            uint exitCode = 0;
            bool hasExitCode = exited && GetExitCodeProcess(process, out exitCode);

            uint processCount = ReapJob(job);

            await WaitForReaders(stdoutTask, stderrTask);
            Snapshot stdout = stdoutCapture.Read();
            Snapshot stderr = stderrCapture.Read();

            return WriteOutcome(args.Nonce, exited, processCount, hasExitCode ? exitCode : (uint?)null, timedOut, stdout, stderr);
        }
        finally
        {
            DeactivateJob();
            if (handlerInstalled) SetConsoleCtrlHandler(ControlHandler, false);
            if (thread != IntPtr.Zero) CloseHandle(thread);
            if (process != IntPtr.Zero) CloseHandle(process);
            if (job != IntPtr.Zero) CloseHandle(job);
            if (attributeList != IntPtr.Zero){if(attributeInitialized)DeleteProcThreadAttributeList(attributeList);Marshal.FreeHGlobal(attributeList);}
            if (environmentPinned) environmentPin.Free();
            stdinWrite?.Dispose();
            stdinRead?.Dispose();
            stdoutWrite?.Dispose();
            stderrWrite?.Dispose();
            stdoutStream?.Dispose();
            stderrStream?.Dispose();
            stdoutRead?.Dispose();
            stderrRead?.Dispose();
            script?.Handle?.Dispose();
            node?.Handle?.Dispose();
            root?.Handle?.Dispose();
        }
    }

    private static void DisposeInspected(params Inspected[] values)
    {
        foreach (Inspected value in values) value?.Handle?.Dispose();
    }

    private static Inspected Inspect(string canonical, string label, bool directory, bool requireCurrentOwner)
    {
        EnsureLocalFixed(canonical, label);
        ValidateAncestorChain(canonical, label);

        uint flags = FileFlagOpenReparsePoint | (directory ? FileFlagBackupSemantics : 0);
        SafeFileHandle handle = CreateFileW(canonical, ReadControl | FileReadAttributes, FileShareRead | FileShareWrite, IntPtr.Zero, OpenExisting, flags, IntPtr.Zero);
        if (handle.IsInvalid) throw new Reject(label + "_OPEN");
        try
        {
            if (!GetFileInformationByHandle(handle, out BY_HANDLE_FILE_INFORMATION info)) throw new Reject(label + "_INFO");
            if ((info.FileAttributes & (FileAttributeReparsePoint | FileAttributeDevice)) != 0) throw new Reject(label + "_NOT_REGULAR");
            bool isDirectory = (info.FileAttributes & FileAttributeDirectory) != 0;
            if (directory != isDirectory) throw new Reject(directory ? label + "_NOT_DIRECTORY" : label + "_NOT_FILE");
            if (!directory && info.NumberOfLinks != 1) throw new Reject(label + "_LINK_COUNT");
            if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfoClass, out FILE_ATTRIBUTE_TAG_INFO tag, (uint)Marshal.SizeOf<FILE_ATTRIBUTE_TAG_INFO>())) throw new Reject(label + "_INFO");
            if ((tag.FileAttributes & (FileAttributeReparsePoint | FileAttributeDevice)) != 0) throw new Reject(label + "_NOT_REGULAR");

            string owner = ReadOwnerSid(handle, label);
            if (string.IsNullOrEmpty(owner) || !IsTrustedPrincipal(owner,true)) throw new Reject(label + "_OWNER");
            string sddl = ReadSddl(handle, label);
            if (requireCurrentOwner && !IsCurrentUser(owner)) throw new Reject(label + "_OWNER");
            if (directory || requireCurrentOwner)
            {
                if (HasBroadAce(sddl)) throw new Reject(label + "_DACL");
            }
            else if (HasBroadWrite(sddl))
            {
                throw new Reject(label + "_DACL_WRITE");
            }

            return new Inspected { Handle = handle };
        }
        catch
        {
            handle.Dispose();
            throw;
        }
    }

    private static void EnsureLocalFixed(string canonical, string label)
    {
        var volumePath = new StringBuilder(1024);
        if (!GetVolumePathNameW(canonical, volumePath, (uint)volumePath.Capacity)) throw new Reject(label + "_VOLUME");
        if (GetDriveTypeW(volumePath.ToString()) != DriveFixed) throw new Reject(label + "_NOT_LOCAL_FIXED");
    }

    private static void ValidateAncestorChain(string canonical, string label)
    {
        string current = Path.GetDirectoryName(canonical);
        while (!string.IsNullOrEmpty(current) && current.Length > 3)
        {
            EnsureLocalFixed(current, label);
            using SafeFileHandle handle = CreateFileW(current, ReadControl | FileReadAttributes, FileShareRead | FileShareWrite, IntPtr.Zero, OpenExisting, FileFlagBackupSemantics | FileFlagOpenReparsePoint, IntPtr.Zero);
            if (handle.IsInvalid) throw new Reject(label + "_ANCESTOR_OPEN");
            if (!GetFileInformationByHandle(handle, out BY_HANDLE_FILE_INFORMATION info)) throw new Reject(label + "_ANCESTOR_INFO");
            if ((info.FileAttributes & (FileAttributeReparsePoint | FileAttributeDevice)) != 0) throw new Reject(label + "_ANCESTOR_REPARSE");
            current = Path.GetDirectoryName(current);
        }
    }

    private static string ReadOwnerSid(SafeFileHandle handle, string label)
    {
        if (GetSecurityInfo(handle, SeFileObject, OwnerSecurityInformation, out IntPtr owner, out _, out _, out _, out IntPtr descriptor) != 0)
        {
            throw new Reject(label + "_OWNER");
        }
        try
        {
            if (owner == IntPtr.Zero) throw new Reject(label + "_OWNER");
            if (!ConvertSidToStringSidW(owner, out IntPtr text)) throw new Reject(label + "_OWNER");
            try
            {
                return Marshal.PtrToStringUni(text) ?? "";
            }
            finally
            {
                LocalFree(text);
            }
        }
        finally
        {
            if (descriptor != IntPtr.Zero) LocalFree(descriptor);
        }
    }

    private static string ReadSddl(SafeFileHandle handle, string label)
    {
        if (GetSecurityInfo(handle, SeFileObject, OwnerSecurityInformation | DaclSecurityInformation, out _, out _, out IntPtr dacl, out _, out IntPtr descriptor) != 0)
        {
            throw new Reject(label + "_DACL");
        }
        try
        {
            if (dacl == IntPtr.Zero) throw new Reject(label + "_DACL");
            if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor, SddlRevision1, OwnerSecurityInformation | DaclSecurityInformation, out IntPtr text, out _))
            {
                throw new Reject(label + "_DACL");
            }
            try
            {
                return Marshal.PtrToStringUni(text) ?? "";
            }
            finally
            {
                LocalFree(text);
            }
        }
        finally
        {
            if (descriptor != IntPtr.Zero) LocalFree(descriptor);
        }
    }

    private static bool IsCurrentUser(string sid)
    {
        string current = WindowsIdentity.GetCurrent().User?.Value;
        return current != null && string.Equals(current, sid, StringComparison.OrdinalIgnoreCase);
    }

    private static bool HasBroadAce(string sddl)
    {
        foreach (string ace in SplitAces(sddl))
        {
            string[] parts = ace.Substring(1, ace.Length - 2).Split(';');
            if(parts.Length!=6)return true;
            if(parts[0]=="D"||parts[0]=="OD"||parts[0]=="XD")continue;
            if(!IsTrustedPrincipal(parts[5],false))return true;
        }
        return false;
    }

    private static bool HasBroadWrite(string sddl)
    {
        foreach (string ace in SplitAces(sddl))
        {
            string[] parts = ace.Substring(1, ace.Length - 2).Split(';');
            if(parts.Length!=6)return true;
            if(parts[0]=="D"||parts[0]=="OD"||parts[0]=="XD")continue;
            if(!IsTrustedPrincipal(parts[5],true)&&RightsAllowWrite(parts[2]))return true;
        }
        return false;
    }

    private static string[] SplitAces(string sddl)
    {
        var list = new List<string>();
        int index = 0;
        while (true)
        {
            int start = sddl.IndexOf('(', index);
            if (start < 0) break;
            int end = sddl.IndexOf(')', start);
            if (end < 0) break;
            list.Add(sddl.Substring(start, end - start + 1));
            index = end + 1;
        }
        return list.ToArray();
    }

    private static bool IsTrustedPrincipal(string sid,bool allowAdministrators){using(var current=WindowsIdentity.GetCurrent()){return string.Equals(sid,current.User?.Value,StringComparison.OrdinalIgnoreCase)||sid=="SY"||sid=="S-1-5-18"||(allowAdministrators&&(sid=="BA"||sid=="S-1-5-32-544"));}}
    private static bool IsBroadSid(string sid)
    {
        switch (sid)
        {
            case "WD":
            case "BU":
            case "AU":
            case "IU":
            case "AN":
            case "S-1-1-0":
            case "S-1-5-11":
            case "S-1-5-32-545":
            case "S-1-5-4":
                return true;
            default:
                return false;
        }
    }

    private static bool RightsAllowWrite(string rights)
    {
        if (string.IsNullOrEmpty(rights)) return true;
        if (string.Equals(rights, "0x1200a9", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(rights, "0x120089", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }
        switch (rights)
        {
            case "FR":
            case "FX":
            case "GR":
            case "GX":
                return false;
            case "GA":
            case "GW":
                return true;
        }
        if (rights.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
        {
            if (!uint.TryParse(rights.Substring(2), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out uint mask))
            {
                return true;
            }
            const uint writeBits =
                0x00000001 | // FILE_WRITE_DATA / FILE_ADD_FILE
                0x00000002 | // FILE_APPEND_DATA / FILE_ADD_SUBDIRECTORY
                0x00000004 | // FILE_WRITE_EA
                0x00000010 | // FILE_WRITE_ATTRIBUTES
                0x00000040 | // FILE_DELETE_CHILD
                0x00000100 | // FILE_WRITE_ACL (standard)
                0x00010000 | // DELETE
                0x00040000 | // WRITE_DAC
                0x00080000 | // WRITE_OWNER
                0x10000000 | // GENERIC_ALL
                0x40000000;  // GENERIC_WRITE
            return (mask & writeBits) != 0;
        }
        // Any unrecognized SDDL rights token is treated as potentially writable.
        return true;
    }

    private static IntPtr BuildEnvironment(string tempRoot, out GCHandle pin)
    {
        var values = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        string[] allowed =
        {
            "SystemRoot", "windir", "PATH", "PATHEXT", "ComSpec",
            "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "PROCESSOR_ARCHITEW6432",
        };
        foreach (string key in allowed)
        {
            if (IsForbiddenEnvironmentKey(key)) continue;
            string value = Environment.GetEnvironmentVariable(key);
            if (!string.IsNullOrEmpty(value) && IsWellFormed(value)) values[key] = value;
        }
        values["TEMP"] = tempRoot;
        values["TMP"] = tempRoot;

        var builder = new StringBuilder();
        foreach (KeyValuePair<string, string> pair in values)
        {
            builder.Append(pair.Key).Append('=').Append(pair.Value).Append('\0');
        }
        builder.Append('\0');

        char[] block = builder.ToString().ToCharArray();
        pin = GCHandle.Alloc(block, GCHandleType.Pinned);
        return pin.AddrOfPinnedObject();
    }

    private static bool IsForbiddenEnvironmentKey(string key)
    {
        return key.StartsWith("FOLIO", StringComparison.OrdinalIgnoreCase)
            || Regex.IsMatch(key, "TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API[_-]?KEY|PRIVATE[_-]?KEY", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    }

    private static void ActivateJob(IntPtr job)
    {
        lock (JobGate)
        {
            activeJob = job;
        }
    }

    private static void DeactivateJob()
    {
        lock (JobGate)
        {
            activeJob = IntPtr.Zero;
        }
    }

    private static uint ReapJob(IntPtr job)
    {
        uint count = ReadProcessCount(job);
        if (count == 0) return 0;
        TerminateJobObject(job, 1);
        int waited = 0;
        while (count > 0 && waited < ReapDeadlineMs)
        {
            System.Threading.Thread.Sleep(50);
            waited += 50;
            count = ReadProcessCount(job);
        }
        return count;
    }

    private static async Task ReadBounded(FileStream stream, Capture capture)
    {
        byte[] buffer = new byte[8192];
        try
        {
            while (true)
            {
                int count = await stream.ReadAsync(buffer.AsMemory(0, buffer.Length)).ConfigureAwait(false);
                if (count <= 0) break;
                capture.Append(buffer, count);
            }
        }
        catch (IOException) { }
        catch (ObjectDisposedException) { }
    }

    private static async Task WaitForReaders(Task first, Task second)
    {
        Task all = Task.WhenAll(first, second);
        Task completed = await Task.WhenAny(all, Task.Delay(5000)).ConfigureAwait(false);
        if (completed == all)
        {
            try { await all.ConfigureAwait(false); } catch { }
        }
    }

    private static uint ReadProcessCount(IntPtr job)
    {
        if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting, (uint)Marshal.SizeOf<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>(), IntPtr.Zero))
        {
            throw new Reject("JOB_QUERY");
        }
        return accounting.ActiveProcesses;
    }

    private static int WriteOutcome(string nonce, bool exited, uint processCount, uint? exitCode, bool timedOut, Snapshot stdout, Snapshot stderr)
    {
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteNumber("v", 1);
            writer.WriteBoolean("owned", true);
            writer.WriteString("nonce", nonce);
            writer.WriteString("ownRootNonce", nonce);
            writer.WriteBoolean("exited", exited);
            writer.WriteNumber("processCount", processCount);
            if (exitCode.HasValue) writer.WriteNumber("exitCode", exitCode.Value);
            else writer.WriteNull("exitCode");
            writer.WriteBoolean("timedOut", timedOut);
            writer.WriteNumber("stdoutBytes", stdout.Bytes);
            writer.WriteNumber("stderrBytes", stderr.Bytes);
            writer.WriteBoolean("truncated", stdout.Truncated || stderr.Truncated);
            writer.WriteEndObject();
        }
        byte[] json = buffer.ToArray();
        if (json.Length > MaxResultBytes) throw new Reject("RESULT_SIZE");
        using Stream output = Console.OpenStandardOutput();
        output.Write(json, 0, json.Length);
        output.Flush();
        return 0;
    }

    private static string Quote(string value)
    {
        var builder = new StringBuilder(value.Length + 2);
        builder.Append('"');
        int backslashes = 0;
        foreach (char current in value)
        {
            if (current == '\\')
            {
                backslashes++;
                continue;
            }
            if (current == '"')
            {
                builder.Append('\\', backslashes * 2 + 1);
                builder.Append('"');
                backslashes = 0;
                continue;
            }
            builder.Append('\\', backslashes);
            backslashes = 0;
            builder.Append(current);
        }
        builder.Append('\\', backslashes * 2);
        builder.Append('"');
        return builder.ToString();
    }

    private static bool OnControl(uint controlType)
    {
        if (controlType != CtrlCloseEvent && controlType != CtrlLogoffEvent && controlType != CtrlShutdownEvent) return false;
        lock (JobGate)
        {
            IntPtr job = activeJob;
            if (job == IntPtr.Zero) return false;
            TerminateJobObject(job, 1);
            return true;
        }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)]
        public bool bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FILETIME
    {
        public uint dwLowDateTime;
        public uint dwHighDateTime;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BY_HANDLE_FILE_INFORMATION
    {
        public uint FileAttributes;
        public FILETIME CreationTime;
        public FILETIME LastAccessTime;
        public FILETIME LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FILE_ATTRIBUTE_TAG_INFO
    {
        public uint FileAttributes;
        public uint ReparseTag;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    private delegate bool HandlerRoutine(uint controlType);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcess(
        string lpApplicationName,
        StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string lpCurrentDirectory,
        ref STARTUPINFOEX lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr hJob, int infoClass, out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info, uint length, IntPtr returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr hJob, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr hProcess, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr hThread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr hHandle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CreatePipe(out SafeFileHandle readPipe, out SafeFileHandle writePipe, ref SECURITY_ATTRIBUTES attributes, uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr hObject, uint mask, uint flags);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern SafeFileHandle CreateFileW(
        string lpFileName,
        uint dwDesiredAccess,
        uint dwShareMode,
        IntPtr lpSecurityAttributes,
        uint dwCreationDisposition,
        uint dwFlagsAndAttributes,
        IntPtr hTemplateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle hFile, out BY_HANDLE_FILE_INFORMATION lpFileInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandleEx(SafeFileHandle hFile, int fileInformationClass, out FILE_ATTRIBUTE_TAG_INFO lpFileInformation, uint dwBufferSize);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool GetVolumePathNameW(string lpszFileName, StringBuilder lpszVolumePathName, uint cchBufferLength);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern uint GetDriveTypeW(string lpRootPathName);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern uint GetSecurityInfo(
        SafeFileHandle handle,
        int objectType,
        uint securityInfo,
        out IntPtr ppsidOwner,
        out IntPtr ppsidGroup,
        out IntPtr ppDacl,
        out IntPtr ppSacl,
        out IntPtr ppSecurityDescriptor);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool ConvertSidToStringSidW(IntPtr sid, out IntPtr stringSid);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(
        IntPtr securityDescriptor,
        uint revision,
        uint securityInformation,
        out IntPtr stringSecurityDescriptor,
        out uint stringSecurityDescriptorLen);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LocalFree(IntPtr hMem);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr lpAttributeList, int dwAttributeCount, int dwFlags, ref IntPtr lpSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(
        IntPtr lpAttributeList,
        uint dwFlags,
        IntPtr attribute,
        IntPtr lpValue,
        UIntPtr cbSize,
        IntPtr lpPreviousValue,
        IntPtr lpReturnSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetConsoleCtrlHandler(HandlerRoutine handler, bool add);
}
