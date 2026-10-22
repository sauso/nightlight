#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef PayloadDir
  #define PayloadDir "build\payload"
#endif
#ifndef OutputDir
  #define OutputDir "dist"
#endif

[Setup]
AppId={{F32C8B8A-45EA-4F57-8E73-CA2B651A94C9}
AppName=Nightlight
AppVersion={#AppVersion}
AppPublisher=Nightlight
AppPublisherURL=https://nightlightbaby.app/
AppSupportURL=https://github.com/sauso/nightlight/issues
DefaultDirName={autopf}\Nightlight
DefaultGroupName=Nightlight
DisableProgramGroupPage=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.19045
PrivilegesRequired=admin
LicenseFile=..\LICENSE
OutputDir={#OutputDir}
OutputBaseFilename=Nightlight-{#AppVersion}-windows-x64-setup
Compression=lzma2/fast
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\node.exe
CloseApplications=no

[Tasks]
Name: lan; Description: "Allow devices on my private home network to connect"; GroupDescription: "Network access:"

[Dirs]
Name: "{commonappdata}\Nightlight"; Flags: uninsneveruninstall
Name: "{commonappdata}\Nightlight\tmp"; Flags: uninsneveruninstall
Name: "{commonappdata}\Nightlight\logs"; Flags: uninsneveruninstall

[InstallDelete]
; The service is stopped in PrepareToInstall before old application files go.
; User data is outside {app} and is never part of this cleanup.
Type: filesandordirs; Name: "{app}\app"
Type: filesandordirs; Name: "{app}\bin"
Type: filesandordirs; Name: "{app}\licenses"

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[INI]
Filename: "{app}\Nightlight.url"; Section: "InternetShortcut"; Key: "URL"; String: "http://localhost:{code:GetHttpPort}"

[UninstallDelete]
Type: files; Name: "{app}\Nightlight.url"
Type: dirifempty; Name: "{app}"

[Icons]
Name: "{group}\Nightlight"; Filename: "{app}\Nightlight.url"
Name: "{group}\Uninstall Nightlight"; Filename: "{uninstallexe}"

[Run]
; The Microsoft installer repairs/updates the shared C++ runtime if needed. It
; is deliberately retained on uninstall because other applications may use it.
Filename: "{app}\redist\vc_redist.x64.exe"; Parameters: "/install /quiet /norestart"; StatusMsg: "Checking the Microsoft Visual C++ runtime..."; Flags: runhidden waituntilterminated
Filename: "{app}\Nightlight.Service.exe"; Parameters: "install"; Flags: runhidden waituntilterminated; Check: NeedsServiceInstall
Filename: "{app}\Nightlight.Service.exe"; Parameters: "start"; Flags: runhidden waituntilterminated
Filename: "{app}\Nightlight.url"; Description: "Open Nightlight"; Flags: postinstall shellexec nowait skipifsilent

[UninstallRun]
Filename: "{app}\Nightlight.Service.exe"; Parameters: "stop"; Flags: runhidden waituntilterminated skipifdoesntexist; RunOnceId: "StopNightlight"
Filename: "{app}\Nightlight.Service.exe"; Parameters: "uninstall"; Flags: runhidden waituntilterminated skipifdoesntexist; RunOnceId: "UninstallNightlightService"
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Nightlight Web"""; Flags: runhidden waituntilterminated; RunOnceId: "RemoveNightlightWebRule"
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Nightlight Video"""; Flags: runhidden waituntilterminated; RunOnceId: "RemoveNightlightVideoRule"

[Code]
var
  PortPage: TInputQueryWizardPage;

function NeedsServiceInstall: Boolean;
begin
  Result := not RegKeyExists(HKLM, 'SYSTEM\CurrentControlSet\Services\Nightlight');
end;

function GetHttpPort(Param: String): String;
begin
  Result := PortPage.Values[0];
end;

procedure InitializeWizard;
begin
  PortPage := CreateInputQueryPage(wpSelectDir, 'Nightlight server',
    'Choose the web port', 'Open this port in your browser to use Nightlight. Existing cameras and recordings are kept when upgrading.');
  PortPage.Add('Web port:', False);
  PortPage.Values[0] := GetIniString('Server', 'Port', '4000',
    ExpandConstant('{commonappdata}\Nightlight\server.ini'));
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Port: Integer;
begin
  Result := True;
  if CurPageID = PortPage.ID then begin
    Port := StrToIntDef(PortPage.Values[0], 0);
    Result := (Port >= 1) and (Port <= 65535);
    if not Result then MsgBox('Choose a whole port number from 1 to 65535.', mbError, MB_OK);
    if Result then PortPage.Values[0] := IntToStr(Port);
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ExitCode: Integer;
  ImagePath: String;
begin
  Result := '';
  if not NeedsServiceInstall then begin
    RegQueryStringValue(HKLM, 'SYSTEM\CurrentControlSet\Services\Nightlight', 'ImagePath', ImagePath);
    if Pos(Lowercase(ExpandConstant('{app}\Nightlight.Service.exe')), Lowercase(ImagePath)) = 0 then begin
      Result := 'A different Nightlight service already exists. Remove it or choose its original installation directory.';
      Exit;
    end;
    if not Exec(ExpandConstant('{app}\Nightlight.Service.exe'), 'stop', '', SW_HIDE, ewWaitUntilTerminated, ExitCode) or (ExitCode <> 0) then
      Result := 'Could not stop the existing Nightlight service. Stop it in Windows Services, then retry. Application files and data have been kept.';
  end;
end;

procedure RunRequired(FileName: String; Arguments: String);
var
  ExitCode: Integer;
begin
  if not Exec(FileName, Arguments, '', SW_HIDE, ewWaitUntilTerminated, ExitCode) or (ExitCode <> 0) then
    RaiseException('Could not configure Nightlight: ' + FileName + '. See the installer log.');
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  DataDir: String;
  ExitCode: Integer;
begin
  if CurStep = ssPostInstall then begin
    DataDir := ExpandConstant('{commonappdata}\Nightlight');
    // Well-known SIDs work on non-English Windows too. LocalService gets Modify;
    // only administrators and SYSTEM get Full control. No Users-wide data grant:
    // the database contains camera passwords in plaintext.
    RunRequired(ExpandConstant('{sys}\icacls.exe'), '"' + DataDir + '" /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-19:(OI)(CI)M"');
    SetIniString('Server', 'Port', GetHttpPort(''), DataDir + '\server.ini');
    Exec(ExpandConstant('{sys}\netsh.exe'), 'advfirewall firewall delete rule name="Nightlight Web"', '', SW_HIDE, ewWaitUntilTerminated, ExitCode);
    Exec(ExpandConstant('{sys}\netsh.exe'), 'advfirewall firewall delete rule name="Nightlight Video"', '', SW_HIDE, ewWaitUntilTerminated, ExitCode);
    if WizardIsTaskSelected('lan') then begin
      RunRequired(ExpandConstant('{sys}\netsh.exe'), 'advfirewall firewall add rule name="Nightlight Web" dir=in action=allow program="' + ExpandConstant('{app}\node.exe') + '" protocol=TCP localport=' + GetHttpPort('') + ' profile=private remoteip=localsubnet');
      RunRequired(ExpandConstant('{sys}\netsh.exe'), 'advfirewall firewall add rule name="Nightlight Video" dir=in action=allow program="' + ExpandConstant('{app}\bin\mediamtx.exe') + '" protocol=UDP localport=8189 profile=private remoteip=localsubnet');
    end;
  end;
end;
