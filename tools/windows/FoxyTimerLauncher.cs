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
        int code = RunNode(node, script, command, baseDir, dataDir, resultFile);

        // 3 = another copy of Foxy Timer (e.g. an older download left running)
        // already has the port. Offer to stop it and carry on.
        if (code == 3 && command == "open")
        {
            string[] lines = File.Exists(resultFile) ? File.ReadAllLines(resultFile) : new string[0];
            string folder = lines.Length > 1 ? lines[1] : "another folder";
            DialogResult answer = MessageBox.Show(
                "Another copy of Foxy Timer is already running, from:\n" + folder +
                "\n\nStop it and start this one?\n\n(Anything connected to the other copy disconnects.)",
                "Foxy Timer", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
            if (answer != DialogResult.Yes) return 0;
            RunNode(node, script, "stop-other", baseDir, dataDir, resultFile);
            try { File.Delete(resultFile); } catch { }
            code = RunNode(node, script, "open", baseDir, dataDir, resultFile);
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

    static int RunNode(string node, string script, string command, string baseDir, string dataDir, string resultFile)
    {
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
        using (Process p = Process.Start(psi))
        {
            p.WaitForExit();
            return p.ExitCode;
        }
    }
}
