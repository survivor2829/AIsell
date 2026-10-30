# scrcpy server and ADB for 手机矩阵

From the official scrcpy release v5.0.1 (https://github.com/Genymobile/scrcpy/releases/tag/v5.0.1),
`scrcpy-win64-v5.0.1.zip`, SHA-256 b12a2c4ee8be317422451fc7dcf8ee20a71b5ea7ef9ad73ddd825a25316227a5
(matching the release's SHA256SUMS.txt). scrcpy is licensed under Apache 2.0 (LICENSE.txt);
`adb.exe`, `AdbWinApi.dll` and `AdbWinUsbApi.dll` are Android platform-tools as shipped by scrcpy.

- `scrcpy-server`: pushed to each phone and started with `app_process`; it streams the screen and
  accepts touch / key / clipboard messages. The client protocol in `phone-stream.cjs` follows this
  exact version (5.0.1); updating the server means checking that protocol again.
- `adb.exe` (+ DLLs): talks to the phones over USB.
