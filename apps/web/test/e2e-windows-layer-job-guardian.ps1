[CmdletBinding(DefaultParameterSetName = 'Run')]
param(
  [Parameter(Mandatory = $true, Position = 0, ParameterSetName = 'Run')]
  [ValidateNotNullOrEmpty()]
  [string] $ConfigurationPath,

  [Parameter(Mandatory = $true, ParameterSetName = 'Launch')]
  [ValidateNotNullOrEmpty()]
  [string] $LaunchConfigurationPath,

  [Parameter(Mandatory = $true, ParameterSetName = 'Capture')]
  [ValidateRange(1, [int]::MaxValue)]
  [int] $CaptureIdentityProcessId
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if ($PSCmdlet.ParameterSetName -eq 'Launch') {
  $launchedProcess = $null
  try {
    if (-not [IO.Path]::IsPathRooted($LaunchConfigurationPath)) { throw 'launch-configuration-path' }
    $launchConfigurationFile = [IO.Path]::GetFullPath($LaunchConfigurationPath)
    if (-not [IO.File]::Exists($launchConfigurationFile)) { throw 'launch-configuration-file' }
    $systemRoot = [Environment]::GetEnvironmentVariable('SystemRoot')
    if ([string]::IsNullOrWhiteSpace($systemRoot)) { throw 'launch-system-root' }
    $powershell = [IO.Path]::Combine($systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    $launchArguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -ConfigurationPath "' + $launchConfigurationFile + '"'
    $launchedProcess = Start-Process -FilePath $powershell -ArgumentList $launchArguments -WindowStyle Hidden -PassThru
    $creationTime = $launchedProcess.StartTime.ToUniversalTime().ToFileTimeUtc()
    if ($creationTime -lt 1) { throw 'launch-process-creation-time' }
    [Console]::Out.WriteLine((@{
      version = 1
      processId = [uint32]$launchedProcess.Id
      creationTime = [string]$creationTime
    } | ConvertTo-Json -Compress))
    exit 0
  }
  catch {
    [Console]::Error.WriteLine('BBX_E2E_PHASE windows-layer-job-launch-failed error-code=1')
    exit 1
  }
  finally {
    if ($null -ne $launchedProcess) { $launchedProcess.Dispose() }
  }
}

$source = @'
using System;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class BbxWindowsLayerJobGuardian
{
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const uint PROCESS_TERMINATE = 0x00000001;
    private const uint PROCESS_SET_QUOTA = 0x00000100;
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x00001000;
    private const uint SYNCHRONIZE = 0x00100000;
    private const uint INFINITE = 0xffffffff;
    private const uint WAIT_OBJECT_0 = 0;
    private const uint WAIT_TIMEOUT = 258;
    private const int JobObjectBasicAccountingInformation = 1;
    private const int JobObjectExtendedLimitInformation = 9;

    [StructLayout(LayoutKind.Sequential)]
    private struct FILETIME
    {
        public uint Low;
        public uint High;
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

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint informationLength, IntPtr returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(IntPtr process, out FILETIME creation, out FILETIME exit, out FILETIME kernel, out FILETIME user);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool waitAll, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FreeConsole();

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

    private static string CreationTime(IntPtr process)
    {
        FILETIME creation;
        FILETIME exit;
        FILETIME kernel;
        FILETIME user;
        Check(GetProcessTimes(process, out creation, out exit, out kernel, out user), "read-process-creation-time");
        ulong value = ((ulong)creation.High << 32) | creation.Low;
        return value.ToString(CultureInfo.InvariantCulture);
    }

    private static IntPtr OpenValidatedProcess(uint processId, string expectedCreationTime, uint access, string label)
    {
        IntPtr process = OpenProcess(access | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, false, processId);
        if (process == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "open-" + label);
        try
        {
            if (CreationTime(process) != expectedCreationTime)
                throw new InvalidOperationException(label + "-identity-mismatch");
            if (WaitForSingleObject(process, 0) == WAIT_OBJECT_0)
                throw new InvalidOperationException(label + "-exited-before-validation");
            return process;
        }
        catch
        {
            CloseHandle(process);
            throw;
        }
    }

    private static uint ActiveProcesses(IntPtr job)
    {
        int size = Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            Check(QueryInformationJobObject(job, JobObjectBasicAccountingInformation, buffer, (uint)size, IntPtr.Zero), "query-layer-job");
            var information = (JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)Marshal.PtrToStructure(buffer, typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
            return information.ActiveProcesses;
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    public static string CaptureIdentity(uint processId)
    {
        IntPtr process = IntPtr.Zero;
        try
        {
            process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, false, processId);
            if (process == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "open-identity-process");
            if (WaitForSingleObject(process, 0) == WAIT_OBJECT_0)
                throw new InvalidOperationException("identity-process-exited");
            return CreationTime(process);
        }
        finally { CloseChecked(ref process, "close-identity-process"); }
    }

    public static void Run(
        uint targetProcessId,
        string targetCreationTime,
        uint ownerProcessId,
        string ownerCreationTime,
        string startedPath,
        string resultPath,
        int cleanupTimeoutMs,
        bool forceConvergenceTimeout)
    {
        IntPtr job = IntPtr.Zero;
        IntPtr target = IntPtr.Zero;
        IntPtr owner = IntPtr.Zero;
        Exception pending = null;
        int stage = 1;
        try
        {
            if (!FreeConsole())
            {
                int consoleError = Marshal.GetLastWin32Error();
                if (consoleError != 6)
                    throw new Win32Exception(consoleError, "detach-layer-console");
            }
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "create-layer-job");
            var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(limits, buffer, false);
                Check(SetInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, (uint)size), "configure-layer-job");
            }
            finally { Marshal.FreeHGlobal(buffer); }

            target = OpenValidatedProcess(targetProcessId, targetCreationTime, PROCESS_TERMINATE | PROCESS_SET_QUOTA, "layer-target");
            owner = OpenValidatedProcess(ownerProcessId, ownerCreationTime, 0, "layer-owner");
            Check(AssignProcessToJobObject(job, target), "assign-layer-process");
            File.WriteAllText(
                startedPath,
                "{\"version\":2,\"targetPid\":" + targetProcessId +
                ",\"targetCreationTime\":\"" + targetCreationTime +
                "\",\"ownerPid\":" + ownerProcessId +
                ",\"ownerCreationTime\":\"" + ownerCreationTime + "\"}",
                new UTF8Encoding(false));
            Console.Out.WriteLine("BBX_E2E_PHASE windows-layer-job-assigned pid=" + targetProcessId);
            stage = 2;

            uint wait = WaitForMultipleObjects(2, new[] { target, owner }, false, INFINITE);
            if (wait != WAIT_OBJECT_0 && wait != WAIT_OBJECT_0 + 1)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "wait-layer-target-or-owner");
            stage = 3;

            if (CreationTime(target) != targetCreationTime)
                throw new InvalidOperationException("layer-target-identity-changed");
            stage = 4;
            Check(TerminateJobObject(job, 1), "terminate-layer-job");
            stage = 5;
            var cleanupClock = System.Diagnostics.Stopwatch.StartNew();
            uint active;
            do
            {
                active = forceConvergenceTimeout ? 1u : ActiveProcesses(job);
                if (active == 0) break;
                if (cleanupClock.ElapsedMilliseconds >= cleanupTimeoutMs)
                    throw new InvalidOperationException("layer-job-cleanup-timeout");
                Thread.Sleep(10);
            } while (true);
            stage = 6;

            File.WriteAllText(
                resultPath,
                "{\"version\":1,\"activeProcesses\":0,\"cleanupCompleted\":true}",
                new UTF8Encoding(false));
            stage = 7;
            Console.Out.WriteLine("BBX_E2E_PHASE windows-layer-job-cleanup-complete active-processes=0");
        }
        catch (Exception error)
        {
            pending = error;
            try
            {
                File.WriteAllText(
                    resultPath,
                    "{\"version\":1,\"cleanupCompleted\":false,\"failureStage\":" + stage + "}",
                    new UTF8Encoding(false));
            }
            catch { }
            Console.Error.WriteLine("BBX_E2E_PHASE windows-layer-job-run-failed error-code=1 stage=" + stage);
            throw;
        }
        finally
        {
            var failures = new System.Collections.Generic.List<Exception>();
            try { CloseChecked(ref target, "close-layer-target"); } catch (Exception error) { failures.Add(error); }
            try { CloseChecked(ref owner, "close-layer-owner"); } catch (Exception error) { failures.Add(error); }
            try { CloseChecked(ref job, "close-layer-job"); } catch (Exception error) { failures.Add(error); }
            if (failures.Count > 0)
            {
                if (pending != null) failures.Insert(0, pending);
                throw new AggregateException("layer-job-handle-cleanup-failed", failures);
            }
        }
    }
}
'@

if ($PSCmdlet.ParameterSetName -eq 'Capture') {
  $capturedProcess = $null
  try {
    $capturedProcess = [Diagnostics.Process]::GetProcessById($CaptureIdentityProcessId)
    $creationTime = $capturedProcess.StartTime.ToUniversalTime().ToFileTimeUtc()
    if ($creationTime -lt 1) { throw 'process-creation-time' }
    [Console]::Out.WriteLine((@{
      version = 1
      processId = [uint32]$CaptureIdentityProcessId
      creationTime = [string]$creationTime
    } | ConvertTo-Json -Compress))
    exit 0
  }
  catch {
    [Console]::Error.WriteLine('BBX_E2E_PHASE windows-process-identity-failed error-code=1')
    exit 1
  }
  finally {
    if ($null -ne $capturedProcess) { $capturedProcess.Dispose() }
  }
}

Add-Type -TypeDefinition $source -Language CSharp

$configurationFile = $null
try {
  if (-not [IO.Path]::IsPathRooted($ConfigurationPath)) { throw 'configuration-path' }
  $configurationFile = [IO.Path]::GetFullPath($ConfigurationPath)
  $configurationInfo = [IO.FileInfo]::new($configurationFile)
  if (-not $configurationInfo.Exists -or $configurationInfo.Length -gt 4096) { throw 'configuration-file' }
  $configuration = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($configurationFile)) | ConvertFrom-Json
  if ($configuration.version -ne 2 -or [string]$configuration.context -ne 'bbx-e2e-layer-job-v2') { throw 'configuration-version' }
  $targetPid = [int64]$configuration.targetPid
  $ownerPid = [int64]$configuration.ownerPid
  $targetCreationTime = [string]$configuration.targetCreationTime
  $ownerCreationTime = [string]$configuration.ownerCreationTime
  $cleanupTimeoutMs = [int64]$configuration.cleanupTimeoutMs
  if (
    $targetPid -lt 1 -or $targetPid -gt [int]::MaxValue -or
    $ownerPid -lt 1 -or $ownerPid -gt [int]::MaxValue -or
    $targetCreationTime -notmatch '^[1-9][0-9]*$' -or
    $ownerCreationTime -notmatch '^[1-9][0-9]*$' -or
    $cleanupTimeoutMs -lt 100 -or $cleanupTimeoutMs -gt 60000
  ) { throw 'configuration-process' }
  $forceConvergenceTimeout = $false
  if ($null -ne $configuration.faultInjection) {
    if (
      [string]$configuration.faultInjection -ne 'convergence-timeout' -or
      $env:BBX_E2E_INTERNAL_LAYER_JOB_FAULT_CONTEXT -ne 'bbx-e2e-layer-job-fault-v1'
    ) { throw 'configuration-fault-injection' }
    $forceConvergenceTimeout = $true
  }
  $startedPath = [IO.Path]::GetFullPath((Join-Path $configurationInfo.DirectoryName 'windows-layer-job-started.json'))
  $resultPath = [IO.Path]::GetFullPath((Join-Path $configurationInfo.DirectoryName 'windows-layer-job-result.json'))
  [BbxWindowsLayerJobGuardian]::Run(
    [uint32]$targetPid,
    $targetCreationTime,
    [uint32]$ownerPid,
    $ownerCreationTime,
    $startedPath,
    $resultPath,
    [int]$cleanupTimeoutMs,
    $forceConvergenceTimeout)
  exit 0
}
catch {
  [Console]::Error.WriteLine('BBX_E2E_PHASE windows-layer-job-failed error-code=1')
  exit 1
}
finally {
  if ($null -ne $configurationFile -and [IO.File]::Exists($configurationFile)) {
    [IO.File]::Delete($configurationFile)
  }
}
