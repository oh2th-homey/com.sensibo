# Sensibo API samples

Real responses from the Sensibo API, kept as a reference for the data the app handles. The app doesn't use them, some tests read them, and the folder is excluded from the app package (`.homeyignore`).

The folders follow the API endpoints. All requests go to `{{baseUrl}}` + the path, with `apiKey` as a query parameter. `baseUrl` is `https://home.sensibo.com/api/v2`.

## Anonymising

Before adding a sample:

- Replace device ids with `<productModel>_id` (for example `skyplus_id`), or `device_<n>_id` when the model is unknown. Use the same placeholder for the same device in every file, including `deviceUid` and `parentDeviceUid`.
- Replace Room Sensor ids (`ms_...`) with `motion_sensor_id`.
- Replace API keys with `your_api_key`. Check URLs, headers and request logs too, not just the response body.
- Replace personal data: user names, emails, MAC addresses (`00:00:00:00:00:<n>`), serial numbers (`<productModel>_serial`), QR ids, Wi-Fi SSIDs and locations.
- Room names and room uids may stay.

File names use the `productModel` value: `airq` is the Sensibo Air Pro, `skyplus` the Sky Plus.

## `users-me-pods/`: all devices of the account

| File | Request | Notes |
| --- | --- | --- |
| `ids-only.json` | `GET /users/me/pods` | Without `fields` only the ids are returned |
| `all-fields.json` | `GET /users/me/pods?fields=*` | Every field of all devices: Air Pro (`productModel: airq`), Sky Plus with a classic Room Sensor, Pure, Elements |
| `poll-item-ac-fahrenheit.json` | `GET /users/me/pods?fields=id,room,productModel,acState,measurements,motionSensors,timer,connectionStatus,filtersCleaning` | One device from the shared poll, AC in Fahrenheit: `acState.temperatureUnit` is `F` with `nativeTargetTemperature` in Celsius, measurements stay in Celsius |

## `pods/`: one device

All with `GET /pods/:device_id?fields=id,room,productModel,acState,measurements,connectionStatus,timer,filtersCleaning,remoteCapabilities,smartMode,motionSensors`, except where noted.

| File | Notes |
| --- | --- |
| `skyplus-celsius-no-climate-react.json` | Without `motionSensors` in `fields`. Climate React never configured: `smartMode` is `null` |
| `skyplus-fahrenheit-room-sensor.json` | AC in Fahrenheit, Climate React changed from the API (`smartmode/post-response.json`). Classic Room Sensor paired (`productModel: motion_sensor`, firmware V17): its `motion` sets the AC's `roomIsOccupied` |
| `skyplus-celsius-climate-react-in-fahrenheit.json` | The same AC switched back to Celsius: the Climate React rules keep their Fahrenheit targets, Sensibo does not convert them |
| `skyplus-celsius-climate-react-resaved.json` | Climate React then saved again in the Sensibo app: both rules' targets converted to Celsius (79 °F → 26 °C, 61 °F → 16 °C, the same table as `toCelsius` in `lib/util.js`), thresholds unchanged |

State change test on the lab Sky Plus, with `GET /pods/:device_id?fields=lastStateChange,lastStateChangeToOn,lastStateChangeToOff,acState`:

| File | Notes |
| --- | --- |
| `skyplus-state-change-1-baseline.json` | Before the test. Rewriting the Climate React settings from Homey earlier did not move `lastStateChange` |
| `skyplus-state-change-2-after-app.json` | Target temperature changed in the Sensibo app: `lastStateChange` moved at once, about a second after the history entry. `acState.timestamp` is only the response time |
| `skyplus-state-change-3-after-remote.json` | Meant to show a change with the AC's own remote, but the remote was used on another AC by mistake. Only shows a later `UserAPI` change from Homey; says nothing about IR capture |
| `skyplus-state-change-4-after-timer.json` | A one-minute Sensibo timer turned the AC off: `lastStateChange` and `lastStateChangeToOff` moved to the same second |

State change test on the Air Pro (`airq`) in room aula, same request. Its `UserAPI` changes every quarter-hour come from energy price Flows on another Homey:

| File | Notes |
| --- | --- |
| `airq-state-change-1-before-remote.json` | `lastStateChange` is the time of the last `ExternalIrCommand` entry (07:00:17): a command from the AC's own remote moves it |
| `airq-state-change-2-after-remote.json` | Fan level changed with the remote (quiet → low): `lastStateChange` moved to the press |

## `acstates/`: AC state history

`GET /pods/:device_id/acStates?limit=3`, from the same test.

| File | Notes |
| --- | --- |
| `history-after-app.json` | Newest first. Each entry has `changedProperties` and a `reason`: `UserRequest` from the Sensibo app, `UserAPI` from the API (Homey). An entry's `acState.timestamp` is only the response time |
| `airq-history-ir-and-trigger.json` | Air Pro: `ExternalIrCommand` is a command from the AC's own remote, captured by the Air Pro. `Trigger` is Climate React acting on its threshold (Climate React is on for aula), and it moved `lastStateChange` to the same second. In fan mode the state has no target temperature |
| `airq-history-remote-press.json` | Air Pro: one remote press gives two `ExternalIrCommand` entries a second apart, first the full state the remote sent, then the change |
| `history-after-remote.json` | Same test step: the remote was used on another AC by mistake, so this says nothing about IR capture. The new entry is a `UserAPI` change |
| `history-after-timer.json` | The timer is recorded as `ScheduledCommand`, changing only `on` |

## `smartmode/`: Climate React

| File | Request | Notes |
| --- | --- | --- |
| `get-not-configured.json` | `GET /pods/:device_id/smartmode` | Never configured: `result` is an empty object |
| `get-fahrenheit-feelslike.json` | `GET /pods/:device_id/smartmode` | Saved in the Sensibo app with the AC in Fahrenheit, trigger feels like. Thresholds are in Celsius with full decimals (24.5556 = 76.2 °F, the app's slider has one decimal), the rules' targets are in Fahrenheit |
| `post-response.json` | `POST /pods/:device_id/smartmode` | Body: `get-fahrenheit-feelslike.json` with the high threshold changed to 26.11 (79.0 °F) and its target to 61 °F. The full configuration is accepted as read, including `deviceUid`, webhooks and `sync_with_ac_power`. The response is the stored configuration |

## `errors/`

| File | Request | Notes |
| --- | --- | --- |
| `pureboost-403.json` | `PUT /pods/:device_id/pureboost` | Logged error object of a 403 response |

## Requests the app makes

| Request | Used for |
| --- | --- |
| `GET /users/me/pods?fields=id,room,productModel,motionSensors` | Pairing |
| `GET /users/me/pods?fields=id,room,productModel,acState,measurements,motionSensors,timer,connectionStatus,filtersCleaning,smartMode` | Shared poll for all devices, once per API key, including Climate React |
| `GET /pods/:device_id?fields=measurements,remoteCapabilities,filtersCleaning` | Supported modes, fan levels and swings |
| `GET /pods/:device_id?fields=timer` | Timer condition |
| `GET /pods/:device_id/acStates?limit=10` | AC state changed trigger |
| `GET /pods/:device_id/smartmode` | Read before changing a Climate React rule |
| `POST /pods/:device_id/smartmode` | Climate React rule cards |
| `PUT /pods/:device_id/smartmode` | Turn Climate React on or off |
