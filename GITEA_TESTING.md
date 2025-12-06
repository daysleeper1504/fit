# Testing the Gitea Integration

This document provides instructions for testing the new Gitea integration feature added to the FIT plugin.

## What's New

The FIT plugin now supports **Gitea** as an alternative to GitHub! You can now sync your Obsidian vault with your own self-hosted Gitea server.

### Key Features Added

1. **Provider Selection**: Choose between GitHub or Gitea in settings
2. **Gitea Server Configuration**: Connect to any Gitea instance by providing the server URL
3. **Connection Testing**: Test your Gitea connection before syncing
4. **Full Sync Support**: All existing FIT features work with Gitea (3-way merge, conflict resolution, auto-sync, etc.)

## Installation for Testing

### Option 1: Test in Development Vault

1. Navigate to your Obsidian vault's plugins directory:
   ```
   <your-vault>/.obsidian/plugins/fit/
   ```

2. Copy these files from the `fit-plugin` directory:
   - `main.js`
   - `manifest.json`
   - `styles.css`

3. Reload Obsidian (Ctrl+R or Cmd+R)

4. Enable the FIT plugin in Settings → Community plugins

### Option 2: Use Plugin Developer Mode

1. In Obsidian, go to Settings → Community plugins
2. Enable "Restricted mode" OFF
3. Click "Browse" and install from the local folder

## Testing Guide

### Prerequisites

- A running Gitea instance (can be local or remote)
- A Gitea account with access token
- An empty or existing repository in Gitea

### Step 1: Get Gitea Access Token

1. Log into your Gitea instance
2. Go to Settings → Applications
3. Create a new access token with these permissions:
   - **repository: Read and Write**
4. Copy the token (you won't see it again!)

### Step 2: Configure FIT Plugin

1. Open Obsidian Settings → FIT

2. **Select Provider**:
   - Choose "Gitea (Self-hosted)" from the Provider dropdown

3. **Configure Gitea Server**:
   - **Gitea Server URL**: Enter your Gitea instance URL (e.g., `https://gitea.example.com`)
   - **Gitea Access Token**: Paste your access token
   - Click "Test Connection" to verify it works ✓

4. **Authenticate User**:
   - Click "Authenticate user" button
   - Your Gitea username and avatar should appear

5. **Select Repository**:
   - Click the refresh icon to fetch your repositories
   - Select a repository from the dropdown
   - Select a branch (usually `main` or `master`)

6. **Configure Local Settings**:
   - Set a device name (e.g., "My Laptop")
   - Configure auto-sync if desired

7. Click outside settings to save

### Step 3: Test Sync Operations

#### First Sync
1. Click the GitHub icon in the left ribbon (it will sync to Gitea)
2. Wait for sync to complete
3. Check your Gitea repository - you should see your vault files!

#### Test Two-Way Sync
1. **Make changes in Obsidian**: Create or edit a note
2. Click sync - changes should push to Gitea
3. **Make changes in Gitea**: Edit a file directly on Gitea
4. Click sync in Obsidian - changes should pull down

#### Test Conflict Resolution
1. Edit the same file in both Obsidian and Gitea (don't sync yet)
2. Click sync in Obsidian
3. Check the `_fit/` folder for conflict files

### Step 4: Switch Between Providers (Optional)

You can switch between GitHub and Gitea:

1. Go to Settings → FIT
2. Change "Provider" dropdown
3. Configure the credentials for the selected provider
4. Sync works independently for each provider

## Troubleshooting

### Connection Test Fails

- **Check URL format**: Should be `https://gitea.example.com` (no trailing slash)
- **Verify token**: Make sure it's not expired and has correct permissions
- **Check network**: Can you access the Gitea URL in your browser?
- **CORS issues**: If self-hosted, ensure CORS is configured

### Authentication Fails

- Token might be expired - create a new one
- Token might not have sufficient permissions - recreate with repository:write
- Gitea server might be down or unreachable

### Sync Fails

- Check if repository exists and you have access
- Check if branch exists
- Look at the debug logs: Settings → FIT → Enable debug logging

### "Remote not found" Error

- Repository name or owner might be incorrect
- Branch might not exist
- Check the repository link shown in settings

## Known Limitations

1. **Ribbon Icon**: The icon still shows "GitHub" - this will be updated in a future release
2. **Large Repositories**: Initial sync of very large repos may take time
3. **Gitea Version**: Tested with Gitea v1.21+, older versions may have API differences

## What to Test

Please test these scenarios and report any issues:

- [ ] Connection to Gitea server works
- [ ] Authentication and user info display
- [ ] Repository and branch listing
- [ ] First sync (empty vault → Gitea)
- [ ] Push changes (Obsidian → Gitea)
- [ ] Pull changes (Gitea → Obsidian)
- [ ] Conflict detection and resolution
- [ ] Auto-sync functionality
- [ ] Switching between GitHub and Gitea
- [ ] Device name appears in commits

## Reporting Issues

When reporting issues, please include:

1. Gitea version
2. Error messages from Obsidian Developer Console (Ctrl+Shift+I)
3. Debug logs (if enabled)
4. Steps to reproduce

## Technical Details

### Architecture

The implementation uses a provider-based architecture:

- **RemoteGitHubVault**: Original GitHub implementation
- **RemoteGiteaVault**: New Gitea implementation
- **IVault**: Common interface both implement
- **Fit**: Provider factory that creates the appropriate vault

### Gitea API Compatibility

Gitea's API is largely compatible with GitHub API v3, so most operations work identically:
- Git tree/blob/commit operations
- Reference updates (push)
- Repository listing
- Branch listing
- User information

### 3-Way Sync

The 3-way merge algorithm works identically for both providers:
1. Fetch local state
2. Fetch remote state
3. Compare with baseline (last sync)
4. Apply non-conflicting changes
5. Report conflicts for manual resolution

All sync operations are provider-agnostic and work through the IVault interface.

## Next Steps

After testing, you can:

1. **Keep using GitHub**: Switch back to GitHub provider anytime
2. **Use Gitea exclusively**: Set Gitea as your provider and enjoy self-hosted sync
3. **Use both**: Different vaults can use different providers

## Credits

Gitea integration developed for the FIT plugin community. Special thanks to the original FIT developers for creating an excellent architecture that made this integration straightforward!
