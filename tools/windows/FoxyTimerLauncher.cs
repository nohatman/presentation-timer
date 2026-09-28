// "Foxy Timer.exe" - the icon a crew member clicks. A Windows (not console)
// program, so no black window appears: it runs the bundled Node with the
// launcher's `open` command (start the local server if it isn't running, open
// the dashboard in the browser) and exits. Anything else on the command line
// is passed through instead (the installer uses `stop`).
//
// Rooms are kept per Windows user in %LOCALAPPDATA%\Foxy Timer\data, outside
// the install folder, so updating or reinstalling never touches them.
//
// Built by scripts/build-local-download.js with the C# compiler that ships
// with Windows (.NET Framework csc.exe) - no extra tools needed.

using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

static class FoxyTimerLauncher
{
    [STAThread]
    static int Main(string[] args)
    {
        string baseDir = AppDomain.CurrentDomain.BaseDirectory;
        string node = Path.Combine(baseDir, "node", "node.exe");
        string script = Path.Combine(baseDir, "app", "tools", "local-server", "foxy-local.js");
        if (!File.Exists(node) || !File.Exists(script))
        {
            MessageBox.Show("Foxy Timer's files are missing from\n" + baseDir + "\n\nPlease reinstall Foxy Timer.",
                "Foxy Timer", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }

        string dataDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Foxy Timer", "data");
        Directory.CreateDirectory(dataDir);
        string resultFile = Path.Combine(dataDir, "last-launch-message.txt");
        try { File.Delete(resultFile); } catch { }

        string command = args.Length > 0 ? string.Join(" ", args) : "open";
        var psi = new ProcessStartInfo(node, "\"" + script + "\" " + command)
        {
            UseShellExecute = false,
            CreateNoWindow = true,      // no console window, ever
            WorkingDirectory = baseDir
        };
        psi.EnvironmentVariables["DATABASE_PATH"] = Path.Combine(dataDir, "foxy-timer.sqlite");
        psi.EnvironmentVariables["FOXY_LOCAL_DATA_DIR"] = Path.Combine(dataDir, "local-server");
        psi.EnvironmentVariables["LEGACY_ROOMS_JSON_PATH"] = Path.Combine(dataDir, "none.json");
        psi.EnvironmentVariables["FOXY_RESULT_FILE"] = resultFile;
        string buildFile = Path.Combine(baseDir, "build.txt");
        if (File.Exists(buildFile)) psi.EnvironmentVariables["FOXY_BUILD_ID"] = File.ReadAllText(buildFile).Trim();

        int code;
        using (Process p = Process.Start(psi))
        {
            p.WaitForExit();
            code = p.ExitCode;
        }

        if (code != 0 && command == "open")
        {
            string message = File.Exists(resultFile) ? File.ReadAllText(resultFile).Trim() : "";
            if (message.Length == 0) message = "Foxy Timer could not start. Try again, or restart the laptop.";
            MessageBox.Show(message + "\n\nHelp: open the Foxy Timer dashboard's Help, or see foxytimer.com.",
                "Foxy Timer", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        return code;
    }
}
