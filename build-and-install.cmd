@echo off
setlocal
cd /d "%~dp0"

set "ROOT=%~dp0.."
if exist "%ROOT%\android-toolchain\jdk-21.0.11+10\bin\java.exe" (
  set "JAVA_HOME=%ROOT%\android-toolchain\jdk-21.0.11+10"
)
if exist "%ROOT%\android-toolchain\sdk\platform-tools\adb.exe" (
  set "ANDROID_HOME=%ROOT%\android-toolchain\sdk"
)

if not exist "%JAVA_HOME%\bin\java.exe" (
  echo Java was not found. Set JAVA_HOME to JDK 17 or newer.
  exit /b 1
)
if not exist "%ANDROID_HOME%\platform-tools\adb.exe" (
  echo Android SDK platform-tools were not found. Set ANDROID_HOME.
  exit /b 1
)
where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo npm was not found. Install Node.js, then run this script again.
  exit /b 1
)

pushd web
if not exist node_modules call npm.cmd ci
if errorlevel 1 exit /b 1
call npm.cmd run build
if errorlevel 1 exit /b 1
popd

xcopy "web\dist\*" "app\src\main\assets\" /E /I /Y >nul
call gradlew.bat --no-daemon assembleDebug
if errorlevel 1 exit /b 1

set "ADB=%ANDROID_HOME%\platform-tools\adb.exe"
"%ADB%" devices
"%ADB%" install -r "app\build\outputs\apk\debug\app-debug.apk"
if errorlevel 1 exit /b 1
"%ADB%" shell am start -n com.sonyjared.chessleak/.MainActivity

echo.
echo Chess Leak is installed and open on the connected phone.
