# Home Assistant Version Control

**Automatic backup, history tracking, and instant restore for your Home Assistant configuration.**

Home Assistant Version Control provides complete version history for your setup. It automatically tracks every change to your YAML configuration files using a robust local Git backend. Browse your history, visualize diffs, and restore individual files or your entire configuration to any previous state with a single click.

![Screenshot 1](images/screenshots/1.png)
![Screenshot 2](images/screenshots/2.png)
![Screenshot 3](images/screenshots/3.png)
![Screenshot 4](images/screenshots/4.png)
![Screenshot 5](images/screenshots/5.png)

##  Key Features

###  Automatic & Smart Tracking
* **Zero-Effort Backups:** Every edit is saved automatically.
* **Smart Debouncing:** Multiple rapid edits are grouped into a single save snapshot (customizable delay).
* **Comprehensive Tracking:** Monitors `.yaml`, `.yml`, and `lovelace` dashboard files (both UI and YAML mode).
* **Efficient Storage:** Uses Git deduplication to minimize disk usage by storing only the differences between versions.

### Timeline & History
* **Chronological Feed:** View changes grouped by "Today," "Yesterday," and "Earlier."
* **Visual Comparisons:** Compare the current version against any backup side-by-side. Additions are highlighted in **green**, deletions in **red**.
* **History Management:** Automatically merges versions older than the specified time period to keep your history clean.

### Instant Restore
* **Granular Control:** Restore specific files or revert your entire configuration.
* **Smart Reloads:** Automatically reloads Home Assistant when restoring automation or script files to apply changes immediately.
* **Instant Rollback:** Long-press the restore button to revert the entire system to a previous point in time.

### Customization
* **Color Theme:** Choose from seven preset color palettes.
* **Light Themes:** Toggle between Light and Dark modes.
* **Comparison View:**
  * **Style:** Customize your comparisons with 8 different themes (High Contrast, GitHub Classic, Neon, etc.).
  * **Layout:** Choose between Stacked (Unified) or Side-by-Side views.
  * **Comparison:**
    * **Current (Default):** Compare against your **Current File** on disk to see how far you've deviated since that backup.
    * **Changes:** Compare against the **Previous Version** to see exactly what changed in that specific backup.

---

## Installation

> [!IMPORTANT]
> 1. **Existing Git Repos:** If you already have a `.git` folder in your `/config` directory, **back it up first**. The add-on will use your existing repository but may conflict with your workflow through auto-commits and automatic merging of old history. **For best results, delete the existing `.git` folder** and let the add-on create a fresh repository.
> 2. **Backup Strategy:** While this add-on provides excellent version control, **do not rely on it as your sole backup method**. Always maintain external backups (e.g., Google Drive, Samba) of your Home Assistant instance.

There are two ways to install Home Assistant Version Control: as a Home Assistant add-on or as a standalone Docker container.

### 1. Home Assistant Add-on (Recommended for most users)

1.  **Add Repository:**
    Click the button below to add the repository to your Home Assistant instance:

      https://github.com/saihgupr/ha-addons

2.  **Install the Add-on:**
    The "Home Assistant Version Control" add-on will now appear in the store. Click on it and then click "Install".

3.  **Start:** Start the add-on and click **"Open Web UI"** to access the interface.

4.  **Optional (External Access):** To access the UI externally at port `54001`, enable the port in the add-on's **Configuration** tab (disabled by default).

### 2. Standalone Docker Installation

For Docker users who aren't using the Home Assistant add-on, you have three deployment options:

**Option A: Docker Compose (recommended):**

1. Download the compose.yaml file:
   ```bash
   curl -o compose.yaml https://raw.githubusercontent.com/saihgupr/home-assistant-version-control/main/compose.yaml
   ```

2. Edit the file to set your paths and timezone:
   ```bash
   nano compose.yaml
   # Update the volume path: /path/to/your/ha/config
   # Update timezone: TZ environment variable (e.g., America/New_York)
   ```

3. Start the service:
   ```bash
   docker compose up -d
   ```

Access the interface at `http://localhost:54001`.

**Option B: Docker Run (pre-built image):**

```bash
docker run -d \
  -p 54001:54001 \
  -v /path/to/your/config:/config \
  -e TZ=America/New_York \
  -e SUPERVISOR_TOKEN=your_long_lived_access_token_here \
  -e HA_URL=http://homeassistant.local:8123 \
  --name home-assistant-version-control \
  ghcr.io/saihgupr/home-assistant-version-control:latest
```

Replace `/path/to/your/config` with the actual path to your Home Assistant configuration directory.

**Option C: Build locally:**

```bash
git clone https://github.com/saihgupr/home-assistant-version-control.git
cd HomeAssistantVersionControl/homeassistant-version-control
docker build --build-arg BUILD_FROM=alpine:latest -t home-assistant-version-control .

docker run -d \
  -p 54001:54001 \
  -v /path/to/your/config:/config \
  -e TZ=America/New_York \
  -e SUPERVISOR_TOKEN=your_long_lived_access_token_here \
  -e HA_URL=http://homeassistant.local:8123 \
  --name home-assistant-version-control \
  home-assistant-version-control
```

> [!NOTE]
> The `SUPERVISOR_TOKEN` and `HA_URL` are optional. You can omit those lines if you don't need Home Assistant restart/reload features.

Access the interface at `http://localhost:54001`.

---

### Restore Actions
* **Restore Single File:** Click the "Restore" button on any file in the timeline.
* **Restore All Files:** Long-press (2 seconds) the "Restore" button on a timeline entry to revert **all tracked files** to that exact moment.

---

## How It Works

### The Workflow
1.  **File Watcher:** The system continuously monitors your `/config` folder for changes to YAML files.
2.  **Stabilization:** When a change is detected, it waits **2 seconds** to ensure Home Assistant has finished writing the file (preventing corruption).
3.  **Debounce:** It then waits for your configured **Debounce Time** (default 5s) to batch related edits into a single commit.
4.  **Snapshot:** A Git commit is created with a timestamp.
5.  **Cleanup:** If enabled, old snapshots are consolidated periodically.

### What is Tracked?
The add-on automatically tracks configuration files while ignoring system files.

| Tracked ✅ | Ignored ❌ |
| :--- | :--- |
| `configuration.yaml` | Database files (`.db`, `.db-shm`) |
| `automations.yaml`, `scripts.yaml` | Log files (`*.log`) |
| `secrets.yaml` | Python cache (`__pycache__`) |
| Lovelace dashboards (`.storage/lovelace*`) | Binary files (Images, Videos) |
| `esphome/*.yaml` | Temporary files |
| All other `.yaml` and `.yml` files | |

---

## API

API for advanced users or automation.

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/api/git/add-all-and-commit` | **Manual Backup:** Forces a commit of all current changes. |
| `POST` | `/api/run-retention` | **Run Cleanup:** Manually triggers the history retention cleanup process. |
| `POST` | `/api/retention/cleanup` | **Advanced Cleanup:** Run cleanup with custom time parameters. |
| `POST` | `/api/restore-commit` | **Time Travel:** Restore ALL files to a specific point in time. |
| `POST` | `/api/restore-file` | **Restore File:** Restore a single file to a specific commit. |
| `POST` | `/api/git/hard-reset` | **Hard Reset:** Reset the repository to a specific commit (destructive). |
| `POST` | `/api/ha/restart` | **Restart HA:** Triggers a Home Assistant restart. |
| `GET` | `/api/git/history` | **Get History:** Returns the full commit history log. |
| `GET` | `/api/git/file-diff` | **File Comparison:** Get the diff for a specific file in a commit. |
| `GET` | `/api/git/commit-diff` | **Commit Comparison:** Get the full diff for a specific commit. |

### Endpoint Details

#### `POST /api/git/hard-reset`
Reset the repository to a specific commit. **WARNING: This is destructive and will discard all changes since that commit.**

**Parameters:**
*   `commitHash` (string, required): The full or short hash of the commit to reset to.
*   `createBackup` (boolean, optional): If `true`, creates a safety backup commit of the current state before resetting. Default: `false`.

**Example:**
```json
{
  "commitHash": "a1b2c3d4",
  "createBackup": true
}
```

#### `POST /api/restore-commit`
Restore all files to their state at a specific commit. This creates a new commit on top of the current history, preserving history.

**Parameters:**
*   `commitHash` (string, required): The hash of the commit to restore.

**Example:**
```json
{
  "commitHash": "e5f6g7h8"
}
```

#### `POST /api/restore-file`
Restore a single file to its state at a specific commit.

**Parameters:**
*   `commitHash` (string, required): The hash of the commit containing the version of the file you want.
*   `filePath` (string, required): The relative path to the file (e.g., `automations.yaml`).

**Example:**
```json
{
  "commitHash": "i9j0k1l2",
  "filePath": "scripts.yaml"
}
```

#### `POST /api/retention/cleanup`
Run the history retention cleanup process with custom parameters.

**Parameters:**
*   `days` (number, optional): Keep history for the last N days.
*   `hours` (number, optional): Keep history for the last N hours.
*   `minutes` (number, optional): Keep history for the last N minutes.
*   `months` (number, optional): Keep history for the last N months.

**Example:**
```bash
curl -X POST http://homeassistant.local:54001/api/retention/cleanup \
  -H "Content-Type: application/json" \
  -d '{"hours": 24}'
```

---

##  Support

Found a bug or have a feature request? Please [submit an issue on GitHub](https://github.com/saihgupr/HomeAssistantVersionControl/issues).

**If you find this add-on helpful, please ⭐ star the repository!**