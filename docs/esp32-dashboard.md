
# ESP32 Dashboard Setup

Display your Claude usage on a physical ESP32 screen using Usage Meter for Claude.

The desktop application sends your current session usage to the ESP32 over local Wi-Fi. The ESP32 displays the percentage, progress bar, and time until your session resets.

This integration is optional and disabled by default.

> ESP32 support is currently available in the development source. It has not yet been released through the Microsoft Store.

## Hardware

The tested configuration is:

| Component | Configuration |
|---|---|
| Board | ESP32-2432S028 (CYD) |
| Screen | 2.8-inch ST7789 TFT |
| Resolution | 320 × 240 landscape |
| Display library | TFT_eSPI |
| Connectivity | Wi-Fi |
| Power | USB |

Other ESP32 displays may require firmware changes.

## 1. Prepare the ESP32

Flash the compatible Claude Usage dashboard firmware using Arduino IDE.

The firmware must:

- Connect to your Wi-Fi network.
- Start an HTTP server on port 80.
- Respond to `GET /health`.
- Accept usage data through `POST /usage`.

The currently tested firmware expects a plain-text payload:

```text
45|1792800000
```

Here, `45` is the session usage percentage and `1792800000` is the reset time in Unix seconds.

The firmware used for this integration is currently maintained separately from the desktop application. This guide does not yet include a downloadable firmware release.

## 2. Find your ESP32 IP address

Open Arduino IDE's Serial Monitor at **115200 baud**.

After connecting to Wi-Fi, note the device's IP address.

For example:

```text
10.0.0.127
```

Your address may differ.

The ESP32 and your Windows computer must be on the same reachable local network.

## 3. Verify connectivity

Open the following URL in your computer's browser, replacing the IP address with your own:

```text
http://10.0.0.127/health
```

The expected response is:

```text
CYD Claude Usage ready
```

If the page doesn't load, check your Wi-Fi connection, device IP address, and router's client-isolation settings.

## 4. Enable ESP32 integration

On Windows, press **Win + R** and enter:

```text
%APPDATA%\Usage Meter for Claude
```

Create a file named `esp32-dashboard.json` with the following complete contents:

```json
{
  "enabled": true,
  "host": "10.0.0.127",
  "port": 80
}
```

Replace the example IP address with your ESP32's actual address.

You can also copy the repository's [example configuration](esp32-dashboard.example.json).

The desktop application accepts private IPv4 destinations only.

## 5. Run Usage Meter for Claude

To run the development version, open PowerShell in the repository directory:

```powershell
npm install
npm start
```

Sign in to Claude if needed.

When usage refreshes successfully, the application sends the current session percentage and reset time to the ESP32.

Select **Refresh now** from the app menu to test it immediately.

The ESP32 should display the same usage percentage as the desktop widget.

## Refresh behavior

The ESP32 receives new usage data whenever the desktop app successfully refreshes.

If the desktop app refreshes every minute, the ESP32 receives updates approximately every minute. If the app refreshes every five minutes, the ESP32 receives updates approximately every five minutes.

The ESP32 updates its displayed reset countdown every 30 seconds without needing another desktop refresh.

If no data arrives for 15 minutes, the ESP32 displays a stale-data indicator.

The ESP32 does not contact Claude directly, so the desktop app must be running to provide fresh usage data.

## Disable the integration

Set `enabled` to `false` in `esp32-dashboard.json`, or delete the file.

The desktop widget continues working normally.

## Security and privacy

Only the session usage percentage and reset timestamp are sent to the ESP32.

Claude authentication credentials, cookies, API keys, and chat contents are not included.

Communication currently uses unencrypted HTTP. The reference firmware does not authenticate requests to `/usage`, so another device with network access to the ESP32 could change the displayed values.

Use the integration only on a trusted private network. Do not expose the ESP32 HTTP server to the public internet.

## Troubleshooting

### The ESP32 doesn't update

- Confirm the desktop application is running and showing current usage.
- Open the ESP32 `/health` endpoint from the Windows computer.
- Check the IP address and port in `esp32-dashboard.json`.
- Confirm that `enabled` is `true`.
- Use **Refresh now** in the desktop application.

### The ESP32 shows old usage

The desktop application may have stopped refreshing or lost network connectivity. Refresh the desktop widget and verify the ESP32 is reachable.

### The Microsoft Store app doesn't send data

The currently published Microsoft Store version may not contain this integration. Run the updated source using `npm start`.

### The ESP32 has a different IP address after restarting

Update the `host` value in `esp32-dashboard.json`.

For a more permanent solution, configure a DHCP reservation for your ESP32 in your router.

## Planned improvements

- Configurable one-, two-, and three-row layouts
- Weekly and model-specific usage limits
- Automatic layout scaling for different screen sizes
- Support for additional ESP32 display models
- Authentication for local device communication

These features are not yet implemented.
