using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

namespace Nightlight.Desktop
{
    internal static class TrayTests
    {
        private static void Assert(bool condition, string message)
        {
            if (!condition) throw new Exception(message);
        }

        [STAThread]
        private static int Main(string[] args)
        {
            string directory = Path.Combine(Path.GetTempPath(), "Nightlight tray tests " + Guid.NewGuid());
            Directory.CreateDirectory(directory);
            try
            {
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                string iconFile = Path.Combine(args[0], "Nightlight.ico");
                File.Copy(iconFile, Path.Combine(directory, "Nightlight.ico"));
                string shortcut = Path.Combine(directory, "Nightlight.url");
                File.WriteAllText(shortcut, "[Other]\r\nURL=http://example.invalid\r\n[InternetShortcut]\r\nURL=http://localhost:4123\r\n");
                Assert(Program.ReadLocalAddress(directory).AbsoluteUri == "http://localhost:4123/", "Custom web port was lost");

                var opened = new List<Uri>();
                using (var context = new TrayContext(directory, opened.Add))
                {
                    context.Menu.Items["open"].PerformClick();
                    context.Menu.Items["settings"].PerformClick();
                    Assert(opened.Count == 2 && opened[0].AbsoluteUri == "http://localhost:4123/", "Open menu target is incorrect");
                    Assert(opened[1].AbsoluteUri == "http://localhost:4123/settings", "Settings menu does not open web settings");
                    File.WriteAllText(shortcut, "[InternetShortcut]\nURL=http://localhost:4080\n");
                    context.Menu.Items["settings"].PerformClick();
                    Assert(opened[2].Port == 4080, "Tray cached the old port");
                    bool exited = false;
                    context.ThreadExit += delegate { exited = true; };
                    context.Menu.Items["exit"].PerformClick();
                    Assert(exited, "Exit menu did not close the tray message loop");
                }
                Console.WriteLine("PASS: actual tray menu opens Nightlight/settings at the selected port and exits");

                foreach (string unsafeUrl in new[] { "https://example.invalid", "http://example.invalid:4000", "file:///C:/Windows", "http://name:password@localhost:4000" })
                {
                    File.WriteAllText(shortcut, "[InternetShortcut]\nURL=" + unsafeUrl + "\n");
                    bool rejected = false;
                    try { Program.ReadLocalAddress(directory); } catch (InvalidDataException) { rejected = true; }
                    Assert(rejected, "Tray accepted a non-local or credential-bearing shortcut");
                }
                Console.WriteLine("PASS: browser launches stay on localhost without reading private ProgramData");

                using (var file = File.OpenRead(iconFile))
                using (var reader = new BinaryReader(file))
                {
                    Assert(reader.ReadUInt16() == 0 && reader.ReadUInt16() == 1, "Missing Windows icon header");
                    int[] sizes = { 16, 20, 24, 32, 48, 64, 128, 256 };
                    Assert(reader.ReadUInt16() == sizes.Length, "Missing native icon sizes");
                    foreach (int size in sizes)
                    {
                        Assert(reader.ReadByte() == size % 256 && reader.ReadByte() == size % 256, "Incorrect icon dimensions");
                        reader.ReadBytes(14);
                    }
                }
                var executables = new List<string> { Path.Combine(args[0], "Nightlight.Tray.exe") };
                for (int i = 1; i < args.Length; i++) executables.Add(args[i]);
                foreach (string executable in executables)
                {
                    using (var embedded = Icon.ExtractAssociatedIcon(executable))
                    using (var expected = new Icon(iconFile, embedded.Size))
                    using (var actualImage = embedded.ToBitmap())
                    using (var expectedImage = expected.ToBitmap())
                    {
                        Assert(actualImage.Size == expectedImage.Size, "Executable icon dimensions differ: " + executable);
                        for (int y = 0; y < actualImage.Height; y++)
                            for (int x = 0; x < actualImage.Width; x++)
                                Assert(actualImage.GetPixel(x, y) == expectedImage.GetPixel(x, y), "Executable does not contain the Nightlight icon: " + executable);
                    }
                }
                Console.WriteLine("PASS: eight native icon sizes and embedded executable branding");
                return 0;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(error);
                return 1;
            }
            finally { Directory.Delete(directory, true); }
        }
    }
}
