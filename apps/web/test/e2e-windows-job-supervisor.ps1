param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateNotNullOrEmpty()]
  [string] $ConfigurationPath
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$source = @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class BbxWindowsJobSupervisor
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const uint INFINITE = 0xffffffff;
    private const uint WAIT_OBJECT_0 = 0;
    private const uint WAIT_TIMEOUT = 258;
    private const uint STILL_ACTIVE = 259;
    private const uint SYNCHRONIZE = 0x00100000;
    private const uint STD_INPUT_HANDLE = unchecked((uint)-10);
    private const uint STD_OUTPUT_HANDLE = unchecked((uint)-11);
    private const uint STD_ERROR_HANDLE = unchecked((uint)-12);
    private const int JobObjectBasicAccountingInformation = 1;
    private const int JobObjectExtendedLimitInformation = 9;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
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

    public sealed class Result
    {
        public uint ChildProcessId { get; set; }
        public uint ExitCode { get; set; }
        public bool ChildResultObserved { get; set; }
        public bool OwnerExited { get; set; }
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool waitAll, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength,
        IntPtr returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(uint standardHandle);

    private static void Check(bool result, string operation)
    {
        if (!result) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }

    private static void CloseChecked(ref IntPtr handle, string operation)
    {
        if (handle == IntPtr.Zero) return;
        IntPtr value = handle;
        handle = IntPtr.Zero;
        Check(CloseHandle(value), operation);
    }

    private static string Quote(string value)
    {
        if (value.IndexOf('\0') >= 0) throw new ArgumentException("NUL in process argument.");
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return value;
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { slashes++; continue; }
            if (character == '"')
            {
                result.Append('\\', slashes * 2 + 1);
                result.Append('"');
                slashes = 0;
                continue;
            }
            result.Append('\\', slashes);
            slashes = 0;
            result.Append(character);
        }
        result.Append('\\', slashes * 2);
        result.Append('"');
        return result.ToString();
    }

    private static uint ActiveProcesses(IntPtr job)
    {
        int size = Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            Check(QueryInformationJobObject(job, JobObjectBasicAccountingInformation, buffer, (uint)size, IntPtr.Zero), "query-job");
            var information = (JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)Marshal.PtrToStructure(buffer, typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
            return information.ActiveProcesses;
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    public static Result Run(string executable, string[] arguments, string workingDirectory, string role, uint ownerProcessId, string startedPath, bool forceAssignmentFailure)
    {
        IntPtr job = IntPtr.Zero;
        IntPtr process = IntPtr.Zero;
        IntPtr thread = IntPtr.Zero;
        IntPtr owner = IntPtr.Zero;
        Exception pending = null;
        bool processCreated = false;
        bool jobCreated = false;
        bool childAssigned = false;
        bool childResumed = false;
        uint childProcessId = 0;
        try
        {
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "create-job");
            jobCreated = true;
            var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            int limitsSize = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr limitsBuffer = Marshal.AllocHGlobal(limitsSize);
            try
            {
                Marshal.StructureToPtr(limits, limitsBuffer, false);
                Check(SetInformationJobObject(job, JobObjectExtendedLimitInformation, limitsBuffer, (uint)limitsSize), "configure-job");
            }
            finally { Marshal.FreeHGlobal(limitsBuffer); }
            Console.Out.WriteLine("BBX_E2E_PHASE windows-job-created");
            owner = OpenProcess(SYNCHRONIZE, false, ownerProcessId);
            if (owner == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "open-owner");

            var commandLine = new StringBuilder(Quote(executable));
            foreach (string argument in arguments) commandLine.Append(' ').Append(Quote(argument));
            var startup = new STARTUPINFO();
            startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            startup.dwFlags = STARTF_USESTDHANDLES;
            startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
            startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
            startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
            PROCESS_INFORMATION information;
            Check(CreateProcess(executable, commandLine, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, IntPtr.Zero, workingDirectory, ref startup, out information), "create-process-suspended");
            process = information.hProcess;
            thread = information.hThread;
            processCreated = true;
            childProcessId = information.dwProcessId;
            Console.Out.WriteLine("BBX_E2E_PHASE windows-job-child-created pid=" + information.dwProcessId);
            if (forceAssignmentFailure) throw new InvalidOperationException("injected-assign-process");
            Check(AssignProcessToJobObject(job, process), "assign-process");
            childAssigned = true;
            Console.Out.WriteLine("BBX_E2E_PHASE windows-job-child-assigned pid=" + information.dwProcessId);
            if (ResumeThread(thread) == 0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error(), "resume-thread");
            childResumed = true;
            CloseChecked(ref thread, "close-thread-handle");
            Console.Out.WriteLine("BBX_E2E_PHASE windows-job-child-resumed pid=" + information.dwProcessId);
            Console.Out.WriteLine("BBX_E2E_PHASE " + role + "-spawned pid=" + information.dwProcessId);
            File.WriteAllText(startedPath, "{\"version\":1,\"childPid\":" + information.dwProcessId + "}", new UTF8Encoding(false));
            uint waitResult = WaitForMultipleObjects(2, new[] { process, owner }, false, INFINITE);
            bool childResultObserved = waitResult == WAIT_OBJECT_0;
            bool ownerExited = waitResult == WAIT_OBJECT_0 + 1;
            if (!childResultObserved && !ownerExited) throw new Win32Exception(Marshal.GetLastWin32Error(), "wait-process-or-owner");
            uint exitCode = 130;
            if (childResultObserved)
            {
                Check(GetExitCodeProcess(process, out exitCode), "read-exit-code");
                Console.Out.WriteLine("BBX_E2E_PHASE windows-job-child-result-observed exit-code=" + exitCode);
            }
            else Console.Out.WriteLine("BBX_E2E_PHASE windows-job-owner-exited");
            Check(TerminateJobObject(job, 1), "terminate-job");
            for (int attempt = 0; attempt < 500 && ActiveProcesses(job) != 0; attempt++) Thread.Sleep(10);
            if (ActiveProcesses(job) != 0) throw new InvalidOperationException("job-cleanup-timeout");
            CloseChecked(ref process, "close-process-handle");
            CloseChecked(ref owner, "close-owner-handle");
            CloseChecked(ref job, "close-job-handle");
            Console.Out.WriteLine("BBX_E2E_PHASE windows-job-cleanup-complete");
            return new Result { ChildProcessId = information.dwProcessId, ExitCode = exitCode, ChildResultObserved = childResultObserved, OwnerExited = ownerExited };
        }
        catch (Exception error)
        {
            pending = error;
            if (processCreated && jobCreated && !childAssigned && !childResumed && process != IntPtr.Zero)
            {
                Exception convergenceFailure = null;
                try
                {
                    Check(TerminateProcess(process, 1), "terminate-unassigned-process");
                    uint wait = WaitForSingleObject(process, 5000);
                    if (wait == WAIT_TIMEOUT) throw new InvalidOperationException("unassigned-process-cleanup-timeout");
                    if (wait != WAIT_OBJECT_0) throw new Win32Exception(Marshal.GetLastWin32Error(), "wait-unassigned-process");
                    uint exactExitCode;
                    Check(GetExitCodeProcess(process, out exactExitCode), "read-unassigned-exit-code");
                    if (exactExitCode == STILL_ACTIVE) throw new InvalidOperationException("unassigned-process-still-active");
                    Console.Out.WriteLine("BBX_E2E_PHASE windows-job-unassigned-child-terminated pid=" + childProcessId);
                }
                catch (Exception cleanupError) { convergenceFailure = cleanupError; }
                if (convergenceFailure != null)
                {
                    pending = new AggregateException("unassigned-child-cleanup-failed", error, convergenceFailure);
                    throw pending;
                }
            }
            throw;
        }
        finally
        {
            var closeFailures = new System.Collections.Generic.List<Exception>();
            try { CloseChecked(ref thread, "close-thread-handle"); } catch (Exception error) { closeFailures.Add(error); }
            try { CloseChecked(ref process, "close-process-handle"); } catch (Exception error) { closeFailures.Add(error); }
            try { CloseChecked(ref owner, "close-owner-handle"); } catch (Exception error) { closeFailures.Add(error); }
            try { CloseChecked(ref job, "close-job-handle"); } catch (Exception error) { closeFailures.Add(error); }
            if (closeFailures.Count > 0)
            {
                if (pending != null) closeFailures.Insert(0, pending);
                throw new AggregateException("native-handle-cleanup-failed", closeFailures);
            }
        }
    }
}
'@

$configurationFile = $null
$removeOwnedDirectory = $false
$failureStage = 1
try {
  if (-not [IO.Path]::IsPathRooted($ConfigurationPath)) { throw 'configuration-path' }
  $configurationFile = [IO.Path]::GetFullPath($ConfigurationPath)
  $configurationInfo = [IO.FileInfo]::new($configurationFile)
  if (-not $configurationInfo.Exists -or $configurationInfo.Length -gt 1048576) { throw 'configuration-file' }
  $configuration = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($configurationFile)) | ConvertFrom-Json
  $failureStage = 2
  if ($configuration.version -ne 1) { throw 'configuration-version' }
  $executable = [IO.Path]::GetFullPath([string]$configuration.executable)
  $workingDirectory = [IO.Path]::GetFullPath([string]$configuration.workingDirectory)
  if (-not [IO.File]::Exists($executable) -or -not [IO.Directory]::Exists($workingDirectory)) { throw 'configuration-target' }
  $arguments = @($configuration.arguments)
  if ($arguments.Count -gt 128) { throw 'configuration-arguments' }
  foreach ($argument in $arguments) {
    if ($null -eq $argument -or ([string]$argument).Length -gt 32768 -or ([string]$argument).Contains([char]0)) { throw 'configuration-argument' }
  }
  $role = [string]$configuration.role
  if ($role -notmatch '^[a-z][a-z0-9-]{0,31}$') { throw 'configuration-role' }
  $ownerPid = [int64]$configuration.ownerPid
  if ($ownerPid -lt 1 -or $ownerPid -gt [int]::MaxValue) { throw 'configuration-owner' }
  $resultPath = [IO.Path]::GetFullPath((Join-Path $configurationInfo.DirectoryName 'windows-job-result.json'))
  $startedPath = [IO.Path]::GetFullPath((Join-Path $configurationInfo.DirectoryName 'windows-job-started.json'))
  $failureStage = 3
  $forceAssignmentFailure = $false
  if ($null -ne $configuration.faultInjection) {
    if (
      [string]$configuration.faultInjection -ne 'assign-process' -or
      $env:BBX_E2E_INTERNAL_JOB_FAULT_CONTEXT -ne 'bbx-e2e-job-fault-v1'
    ) { throw 'configuration-fault-injection' }
    $forceAssignmentFailure = $true
  }
  Add-Type -TypeDefinition $source -Language CSharp
  $failureStage = 4
  $result = [BbxWindowsJobSupervisor]::Run($executable, [string[]]$arguments, $workingDirectory, $role, [uint32]$ownerPid, $startedPath, $forceAssignmentFailure)
  $failureStage = 5
  if ($result.ExitCode -gt 255) { throw 'child-exit-code' }
  $removeOwnedDirectory = [bool]$result.OwnerExited
  [IO.Directory]::CreateDirectory($configurationInfo.DirectoryName) | Out-Null
  $payload = [ordered]@{
    version = 1
    supervisorPid = $PID
    childPid = [uint32]$result.ChildProcessId
    exitCode = [uint32]$result.ExitCode
    jobCreated = $true
    childAssignedBeforeResume = $true
    childResultObserved = [bool]$result.ChildResultObserved
    ownerExited = [bool]$result.OwnerExited
    jobCleanupCompleted = $true
  } | ConvertTo-Json -Compress
  if (-not $removeOwnedDirectory) {
    [IO.File]::WriteAllText($resultPath, $payload, [Text.UTF8Encoding]::new($false))
  }
  exit [int]$result.ExitCode
}
catch {
  [Console]::Error.WriteLine("BBX_E2E_PHASE windows-job-supervisor-failed error-code=1 stage=$failureStage")
  exit 1
}
finally {
  if ($null -ne $configurationFile -and [IO.File]::Exists($configurationFile)) {
    [IO.File]::Delete($configurationFile)
  }
  if ($removeOwnedDirectory -and $null -ne $startedPath -and [IO.File]::Exists($startedPath)) {
    [IO.File]::Delete($startedPath)
  }
  if ($removeOwnedDirectory -and $null -ne $configurationInfo -and [IO.Directory]::Exists($configurationInfo.DirectoryName)) {
    for ($attempt = 0; $attempt -lt 50 -and [IO.Directory]::Exists($configurationInfo.DirectoryName); $attempt++) {
      try { [IO.Directory]::Delete($configurationInfo.DirectoryName, $false) }
      catch [IO.IOException] {
        if ($attempt -eq 49) { throw }
        [Threading.Thread]::Sleep(10)
      }
    }
  }
}
