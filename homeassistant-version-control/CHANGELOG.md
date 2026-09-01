# Changelog

## [1.3.0]

### Added
- **Native iOS HIG Mobile & Tablet Experience:**
  - Added modern responsive layout tailored for mobile devices and tablets.
  - Added glassmorphic bottom navigation tab bar for fast switching between History, Files, Automations, Scripts, and Settings on mobile.
  - Built smooth master-detail sliding view controller with mobile back navigation (`‹ Back`).
  - Added 44px+ touch-friendly target sizing with active feedback states and safe-area inset support (`env(safe-area-inset-*)`).
  - Modal action sheets with swipe-to-dismiss gesture handles for diff and preview dialogs.
- **Real-Time Settings Auto-Save:**
  - Full automatic real-time saving across all settings controls (toggles, debounce timers, retention values, max commits, themes, diff preferences, and cloud sync) on both mobile and desktop.
  - Removed redundant "Save Settings" / "Close" footer buttons on mobile.
- **SSH Key Authentication & Remote Support:** Full support for custom SSH keys loaded from `/config/.ssh` for Git operations over SSH with Gitea, GitLab, GitHub, and custom servers.
- **GitLab Integration Guide:** Added setup documentation for GitLab private repositories and Access Tokens.
- **UI Customizations:** Configurable arrow direction for commit/push visual indicators, timeline item spacing fixes, and sort dropdown fixes.
- **Flush Repository Tool:** Conveniently reset local Git repository state directly from the settings interface.
- **Environment Variables:** Support for custom environment variables like `CONFIG_PATH`.

### Fixed & Improved
- **Edge-to-Edge Mobile Layout:** Removed outer floating window borders and padding on mobile viewports (`<= 768px`) to maximize horizontal and vertical usable space.
- **Mobile Header Streamlining:** Removed redundant top branding header bar on mobile to integrate seamlessly with Home Assistant's top bar.
- **Compact Mobile Action Buttons:** Streamlined "Restore This Version" button text to "Restore" on mobile viewports for clean single-line header alignment.
- **Mobile Settings Window:** Rendered Settings as a full-page standard window matching all other tabs instead of an inset floating sheet.
- **Ignore Rules in Manual Commits:** Fixed `add-all-and-commit` endpoint to strictly respect `.gitignore` rules and custom file/folder exclusions.
- **Watcher Exclusions & Performance:** Improved file watcher path normalization and unwatching logic to significantly reduce memory and CPU overhead.
- **UI Header Cleanups:** Removed static version badges from header and startup logs for consistent display.
- **Supervisor 2026.04.0+ Compatibility:** Multi-arch build updates ensuring compatibility across all Home Assistant Supervisor platforms.

## [1.2.3]

### Fixed
- **Multi-Arch Support:** Added `build.yaml` to ensure correct base images are pulled for all supported architectures (aarch64, amd64, armhf, armv7, i386), fixing "failed to install" errors on various platforms.

## [1.2.2]

### Fixed
- **Multi-Arch Support:** Switched to architecture-agnostic base image in Dockerfile to fix build failures on `aarch64` (HA Green) and newer Home Assistant Supervisor versions (2026.04.0+).

## [1.2.1]

### Fixed
- UI and stability refinements.

## [1.2.0]

### Added
- **Track UI-configured Settings:** Added `include_storage` to track things you set up through the Home Assistant interface (like Areas, Persons, and Zones) that are normally hidden from version control.
- **Additional Paths Tracking:** Added `additional_paths` option to track files outside `/config` (including mapped paths like `/share` and `/media`) while syncing them into version control.
- **Remote URL Configuration:** Added `remote_url` option to the addon configuration to allow easily changing the remote repository URL from the Home Assistant UI.
- **Smart SSH Key Loader:** Persistently load SSH keys from `/config/.ssh` into the addon environment.
- **Trusted CA Certificates:** Automatically sync and trust root CA certificates from `/config/additional_ca` for secure connections to private Git remotes.
- **Confetti Mode:** Celebrate every successful restore with a realistic confetti burst (opt-in via settings).
- **History Control:** New setting to choose exactly how many commits to keep in your history, helping manage storage on smaller devices.
- **Manual Mode:** New option to disable automatic file watching and backups. Perfect for users who want full control over when versions are created.
- **Resizable Panels:** The side and main panels can now be resized by dragging the gap between them.
- **Header Palette Cycle:** Clicking the header title or logo now cycles through available accent color palettes.
- **Manual Mode Only:** Added a new setting to disable automatic versioning and file watching. A "Backup Now" button appears in the sidebar to trigger snapshots manually.

### Fixed
- **Dynamic File Formats:** Fixed issue where `.py`, `.json`, and `.txt` formats were hardcoded to `false` in `server.js`, ignoring the `include_extensions` configuration.
- **Default Branch Transition:** New repositories now default to `main` (standard Git naming). Existing repositories on `master` or other branches are detected automatically and supported without intervention.
- **Cloud Sync Branch:** Improved dynamic detection to ensure sync always follows the active local branch.
- **Storage File UX:** `include_storage` entries now appear in Files/history and participate in restore/filter flows exactly as configured (not limited to `lovelace*` files).
- **UI Refinement:** Re-ordered settings menu for better logical flow (Max Commits moved below history retention).
- **Timeline Path Display:** Fixed issue where file paths in the timeline tab were showing the `.havc_external/` prefix for additional paths.
- **Files Tab External Path Display:** External mirrored paths now render as virtual `/share/...` and `/media/...` paths, with top-level `share` and `media` folders shown directly instead of `.havc_external`.
- **Documentation:** Fixed Docker image name typo in README.
- **Automation Diff Line Numbers:** Corrected line number synchronization in automation and script diff views when comparing isolated YAML content. Diffs now always start at line 1, preventing offsets during history browsing and after file deletions.
- **File Watcher Ignore Logic:** Fixed issue where excluded files (like camera snapshots) were still triggering Git operations, causing `index.lock` errors and high system load.
- **Storage File Tracking Cleanup:** Added automatic untracking for `.storage/` files that are removed from the `include_storage` list, ensuring your Git repository accurately reflects your current settings.
- **Watcher Optimization:** The addon now proactively "unwatches" excluded paths to reduce resource usage.

## [1.1.1]

### Fixed
- Fixed issue with `secrets.yaml` exclusion in cloud sync

## [1.1.0]

### Added
- **Cloud Backup:** Push your configuration to a private GitHub or Gitea repository. Choose to sync manually, daily, or automatically after every change.
- **Custom Extensions:** Track any file format (e.g., `.sh`, `.py`, `.json`, `.conf`) by adding it to the configuration.
- **Manual Mode:** Option to disable file watching and only trigger backups manually via the "Backup Now" button.
- **Efficient Storage:** Uses Git deduplication to minimize disk usage.
- **Recover Deleted Items:** View and restore files, automations, and scripts that have been deleted. Look for the "Deleted" option in the sort menu.
- **Progressive History Loading:** Versions now load faster, displaying results as they're found.
- **Quick Style Toggle:** Tap the header bar of any file diff to cycle through different visual themes instantly.