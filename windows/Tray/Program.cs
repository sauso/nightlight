// .NET Framework / Windows Forms: supplied by supported Windows versions.
// This is a per-user desktop companion. The monitoring service never runs UI.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("Nightlight")]
[assembly: AssemblyProduct("Nightlight")]
[assembly: AssemblyDescription("Nightlight system tray")]

namespace Nightlight.Desktop
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            // Setup runs this elevated to close companions in every session
            // before replacing/removing files. Never signal the server service.
            if (args.Length == 1 && args[0] == "--exit")
                return CloseRunningCompanions(Application.ExecutablePath);

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            try
            {
                string action = args.Length == 0 ? "" : args[0];
                if (args.Length > 1 || (action != "" && action != "--open" && action != "--settings"))
                    throw new ArgumentException("Unknown Nightlight tray option.");

                // A second invocation can open the browser without creating a
                // second icon. No credentials or elevated service access needed.
                if (action != "")
                    OpenBrowser(new Uri(ReadLocalAddress(AppDomain.CurrentDomain.BaseDirectory),
                        action == "--settings" ? "settings" : ""));

                bool created;
                string name = "Local\\Nightlight.Tray." + WindowsIdentity.GetCurrent().User.Value;
                using (var instance = new Mutex(true, name, out created))
                {
                    if (!created) return 0;
                    try
                    {
                        using (var context = new TrayContext(AppDomain.CurrentDomain.BaseDirectory, OpenBrowser))
                            Application.Run(context);
                    }
                    finally { instance.ReleaseMutex(); }
                }
                return 0;
            }
            catch (Exception error)
            {
                MessageBox.Show(error.Message, "Nightlight", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return 1;
            }
        }

        internal static Uri ReadLocalAddress(string directory)
        {
            // The public Start menu URL is readable by normal desktop users.
            // ProgramData is deliberately private: it contains camera secrets.
            bool shortcut = false;
            foreach (string raw in File.ReadAllLines(Path.Combine(directory, "Nightlight.url")))
            {
                string line = raw.Trim();
                if (line.StartsWith("["))
                    shortcut = line.Equals("[InternetShortcut]", StringComparison.OrdinalIgnoreCase);
                if (!shortcut || !line.StartsWith("URL=", StringComparison.OrdinalIgnoreCase)) continue;
                Uri address;
                if (Uri.TryCreate(line.Substring(4).Trim(), UriKind.Absolute, out address)
                    && address.Scheme == "http" && address.Host == "localhost"
                    && address.UserInfo == "" && address.Port > 0)
                    return new UriBuilder("http", "localhost", address.Port).Uri;
                break;
            }
            throw new InvalidDataException("Nightlight's local shortcut is missing or invalid. Run setup again to repair it.");
        }

        private static void OpenBrowser(Uri address)
        {
            Process.Start(new ProcessStartInfo(address.AbsoluteUri) { UseShellExecute = true });
        }

        private static int CloseRunningCompanions(string executable)
        {
            int currentId = Process.GetCurrentProcess().Id;
            foreach (Process process in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(executable)))
            {
                using (process)
                {
                    if (process.Id == currentId) continue;
                    try
                    {
                        // Scope shutdown to this installation, including other
                        // signed-in users. Leave unrelated executables alone.
                        if (!String.Equals(process.MainModule.FileName, executable, StringComparison.OrdinalIgnoreCase)) continue;
                        // ShowInTaskbar=false gives the tray window an owner,
                        // so Process.MainWindowHandle/CloseMainWindow miss it.
                        IntPtr window = FindTrayWindow(process);
                        if (window != IntPtr.Zero) PostMessage(window, 0x0010, IntPtr.Zero, IntPtr.Zero); // WM_CLOSE
                        if (!process.WaitForExit(5000))
                        {
                            process.Kill(); // Only the stateless desktop icon.
                            if (!process.WaitForExit(5000)) return 1;
                        }
                    }
                    catch (InvalidOperationException) { } // Already exited.
                    catch (System.ComponentModel.Win32Exception) { return 1; }
                }
            }
            return 0;
        }

        private delegate bool WindowCallback(IntPtr window, IntPtr parameter);
        [DllImport("user32.dll")]
        private static extern bool EnumThreadWindows(uint threadId, WindowCallback callback, IntPtr parameter);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetClassName(IntPtr window, StringBuilder text, int count);
        [DllImport("user32.dll")]
        private static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

        private static IntPtr FindTrayWindow(Process process)
        {
            IntPtr found = IntPtr.Zero;
            foreach (ProcessThread thread in process.Threads)
            {
                EnumThreadWindows((uint)thread.Id, delegate(IntPtr window, IntPtr parameter)
                {
                    var title = new StringBuilder(256);
                    var type = new StringBuilder(256);
                    GetWindowText(window, title, title.Capacity);
                    GetClassName(window, type, type.Capacity);
                    if (title.ToString() != "Nightlight" || !type.ToString().StartsWith("WindowsForms10.Window", StringComparison.Ordinal)) return true;
                    found = window;
                    return false;
                }, IntPtr.Zero);
                if (found != IntPtr.Zero) break;
            }
            return found;
        }
    }

    internal sealed class TrayContext : ApplicationContext
    {
        private readonly NotifyIcon notification;
        private readonly Icon icon;
        private readonly string directory;
        private readonly Action<Uri> openBrowser;
        internal ContextMenuStrip Menu { get; private set; }

        internal TrayContext(string directory, Action<Uri> openBrowser)
        {
            this.directory = directory;
            this.openBrowser = openBrowser;
            // A non-activating offscreen window accepts normal WM_CLOSE and
            // session-ending messages, allowing clean upgrade/logoff shutdown.
            MainForm = new TrayWindow();
            icon = new Icon(Path.Combine(directory, "Nightlight.ico"), SystemInformation.SmallIconSize);
            Menu = new ContextMenuStrip();
            var open = new ToolStripMenuItem("Open Nightlight") { Name = "open", Font = new Font(Menu.Font, FontStyle.Bold) };
            open.Click += delegate { Open(""); };
            Menu.Items.Add(open);
            var settings = new ToolStripMenuItem("Settings") { Name = "settings" };
            settings.Click += delegate { Open("settings"); };
            Menu.Items.Add(settings);
            Menu.Items.Add(new ToolStripSeparator());
            var exit = new ToolStripMenuItem("Exit tray (monitoring continues)") { Name = "exit" };
            exit.Click += delegate { ExitThread(); };
            Menu.Items.Add(exit);
            notification = new NotifyIcon { Text = "Nightlight", Icon = icon, ContextMenuStrip = Menu, Visible = true };
            notification.MouseDoubleClick += delegate(object sender, MouseEventArgs click)
            {
                if (click.Button == MouseButtons.Left) Open("");
            };
        }

        private void Open(string path)
        {
            try { openBrowser(new Uri(Program.ReadLocalAddress(directory), path)); }
            catch (Exception error)
            {
                MessageBox.Show(error.Message, "Nightlight", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        protected override void ExitThreadCore()
        {
            notification.Visible = false;
            base.ExitThreadCore();
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                notification.Visible = false;
                notification.Dispose();
                Menu.Dispose();
                icon.Dispose();
                if (MainForm != null) MainForm.Dispose();
            }
            base.Dispose(disposing);
        }
    }

    internal sealed class TrayWindow : Form
    {
        internal TrayWindow()
        {
            Text = "Nightlight";
            ShowInTaskbar = false;
            FormBorderStyle = FormBorderStyle.FixedToolWindow;
            StartPosition = FormStartPosition.Manual;
            Location = new Point(-32000, -32000);
            Size = new Size(1, 1);
            Opacity = 0;
        }

        protected override bool ShowWithoutActivation { get { return true; } }
    }
}
