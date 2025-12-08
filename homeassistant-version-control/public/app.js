// API endpoint is relative to the current page
const API = 'api';
let currentMode = 'timeline';
let currentSelection = null;
let modalData = null;
let allCommits = [];
let currentlyDisplayedCommitHash = null;
let sortState = {
  files: localStorage.getItem('sort_files') || 'recently_modified',
  automations: localStorage.getItem('sort_automations') || 'name_asc',
  scripts: localStorage.getItem('sort_scripts') || 'name_asc'
};

// Keyboard navigation state
let keyboardNav = {
  currentList: null,  // 'commits', 'files', 'automations', 'scripts'
  selectedIndex: -1,
  items: []
};


// Font management
let currentFont = localStorage.getItem('diffFont') || 'System';
const fontOptions = [
  { name: 'System', stack: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif' },
  { name: 'SF Pro', stack: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
  { name: 'Roboto', stack: 'Roboto, "Helvetica Neue", sans-serif' },
  { name: 'Segoe UI', stack: '"Segoe UI", Tahoma, Geneva, Verdana, sans-serif' },
  { name: 'Ubuntu', stack: 'Ubuntu, "Segoe UI", sans-serif' },
  { name: 'Helvetica', stack: '"Helvetica Neue", Helvetica, Arial, sans-serif' },
  { name: 'Arial', stack: 'Arial, "Helvetica Neue", sans-serif' },
  { name: 'Inter', stack: 'Inter, system-ui, -apple-system, sans-serif' }
];

// Font size management
let currentFontSize = localStorage.getItem('diffFontSize') || '13px';
const fontSizeOptions = [
  { name: 'XS', size: '11px' },
  { name: 'S', size: '12px' },
  { name: 'M', size: '13px' },
  { name: 'L', size: '14px' },
  { name: 'XL', size: '16px' }
];

// Diff style management
let currentDiffStyle = localStorage.getItem('diffStyle') || 'style-2';
const diffStyleOptions = [
  { id: 'style-2', name: 'High Contrast', description: 'Bold and bright' },
  { id: 'style-1', name: 'GitHub Classic', description: 'Subtle, clean look' },
  { id: 'style-3', name: 'Modern Gradient', description: 'Contemporary gradients' },
  { id: 'style-4', name: 'Terminal', description: 'Matrix-style monospace' },
  { id: 'style-5', name: 'Neon', description: 'Futuristic accents' },
  { id: 'style-6', name: 'Pastel', description: 'Soft designer theme' },
  { id: 'style-7', name: 'Minimal Border', description: 'Ultra-clean borders' },
  { id: 'style-8', name: 'Split Highlight', description: 'Word-level emphasis' }
];

// Diff view format management
let diffViewFormat = localStorage.getItem('diffViewFormat') || 'split';

// Diff mode management - 'shifted' shows what each version changed, 'standard' is normal
let diffMode = localStorage.getItem('diffMode') || 'shifted';

// Compare to Current mode - true = compare to current file, false = compare to parent commit (GitHub-style)
let compareToCurrent = localStorage.getItem('compareToCurrent') !== 'false'; // Default: true (ON)

// Localization
let translations = {};
let currentLanguage = 'en';

async function loadLanguage(lang = 'en') {
  try {
    // Add cache-busting parameter to prevent stale cached translations
    const response = await fetch(`lang/${lang}.json?v=${Date.now()}`);
    if (response.ok) {
      translations = await response.json();
      currentLanguage = lang;
      updateStaticText();
    } else {
      console.error(`Failed to load language: ${lang}`);
    }
  } catch (error) {
    console.error('Error loading language:', error);
  }
}

function t(key, params = {}) {
  const keys = key.split('.');
  let value = translations;

  for (const k of keys) {
    if (value && value[k]) {
      value = value[k];
    } else {
      return key; // Return key if translation missing
    }
  }

  if (typeof value !== 'string') return key;

  // Replace parameters
  Object.keys(params).forEach(param => {
    value = value.replace(`{${param}}`, params[param]);
  });

  return value;
}

function updateStaticText() {
  document.querySelectorAll('[data-i18n]').forEach(element => {
    const key = element.getAttribute('data-i18n');
    const translation = t(key);
    if (element.tagName === 'INPUT' && element.getAttribute('placeholder')) {
      element.placeholder = translation;
    } else {
      element.textContent = translation;
    }
  });

  // Update document title
  document.title = t('app.title');
}

// Load settings from server and localStorage on page load
async function loadSettings() {
  try {
    const response = await fetch(`${API}/runtime-settings`);
    if (response.ok) {
      const data = await response.json();
      const settings = data.settings;

      // Update UI with server settings
      if (settings) {
        // Debounce time
        document.getElementById('debounceTime').value = settings.debounceTime;
        localStorage.setItem('debounceTime', settings.debounceTime);

        // Debounce time unit
        document.getElementById('debounceTimeUnit').value = settings.debounceTimeUnit;
        localStorage.setItem('debounceTimeUnit', settings.debounceTimeUnit);

        // History retention
        document.getElementById('historyRetention').checked = settings.historyRetention;
        localStorage.setItem('historyRetention', settings.historyRetention);

        // Retention type (hardcoded to time now)
        localStorage.setItem('retentionType', 'time');

        // Retention value
        document.getElementById('retentionValue').value = settings.retentionValue;
        localStorage.setItem('retentionValue', settings.retentionValue);

        // Retention unit
        document.getElementById('retentionUnit').value = settings.retentionUnit;
        localStorage.setItem('retentionUnit', settings.retentionUnit);

        // Run cleanup on commit

      }
    }
  } catch (error) {
    console.error('Error loading settings from server:', error);
  }
}

// Load settings from localStorage on page load
window.addEventListener('DOMContentLoaded', async () => {
  // Load language first
  await loadLanguage('en');

  // Load dark mode setting
  // Load dark mode setting
  const darkMode = localStorage.getItem('darkMode');
  const themeLight = document.getElementById('themeLight');
  const themeDark = document.getElementById('themeDark');

  // Default to Dark Mode if not set (null) or explicitly true
  if (darkMode === 'false') {
    document.body.classList.remove('dark-mode');
    if (themeLight) themeLight.checked = true;
  } else {
    document.body.classList.add('dark-mode');
    if (themeDark) themeDark.checked = true;
  }

  // Load settings from server (overrides localStorage defaults)
  await loadSettings();

  // Initialize font
  applyFontToDiffs();
  updateFontButton();
  updateFontSizeButton();


  // Load other settings that are not in runtime settings



  // Initialize the UI state
  handleRetentionToggle();

  const historyRetentionCheckbox = document.getElementById('historyRetention');
  if (historyRetentionCheckbox) {
    historyRetentionCheckbox.addEventListener('change', handleRetentionToggle);
  }

  if (themeLight && themeDark) {
    if (document.body.classList.contains('dark-mode')) {
      themeDark.checked = true;
    } else {
      themeLight.checked = true;
    }
  }

  // Initialize Theme Colors
  const colorPalette = document.getElementById('colorPalette');
  const primaryColorInput = document.getElementById('picassoPrimaryColor');
  const secondaryColorInput = document.getElementById('picassoSecondaryColor');

  // Load saved colors or use defaults
  const savedPrimaryColor = localStorage.getItem('picassoPrimaryColor') || '#c4ba52';
  const savedSecondaryColor = localStorage.getItem('picassoSecondaryColor') || '#00abab';

  primaryColorInput.value = savedPrimaryColor;
  secondaryColorInput.value = savedSecondaryColor;

  // Always apply colors and show palette
  applyPicassoColors(savedPrimaryColor, savedSecondaryColor);
  if (colorPalette) {
    colorPalette.style.display = 'block';
  }

  // Initialize color palettes
  console.log('[App] Initializing color palettes...');
  initializeColorPalettes();
  updatePaletteSelection(savedPrimaryColor, savedSecondaryColor);

  // Add event listeners for color pickers
  primaryColorInput.addEventListener('input', function () {
    const primaryColor = this.value;
    const secondaryColor = secondaryColorInput.value;
    console.log('[Picasso] Primary changed:', primaryColor, 'Secondary is:', secondaryColor);
    localStorage.setItem('picassoPrimaryColor', primaryColor);
    applyPicassoColors(primaryColor, secondaryColor);
  });

  secondaryColorInput.addEventListener('input', function () {
    const primaryColor = primaryColorInput.value;
    const secondaryColor = this.value;
    console.log('[Picasso] Secondary changed:', secondaryColor, 'Primary is:', primaryColor);
    localStorage.setItem('picassoSecondaryColor', secondaryColor);
    applyPicassoColors(primaryColor, secondaryColor);
  });



  // Load diff view format setting (radio buttons)
  const diffViewSplit = document.getElementById('diffViewSplit');
  const diffViewUnified = document.getElementById('diffViewUnified');
  if (diffViewSplit && diffViewUnified) {
    if (diffViewFormat === 'split') {
      diffViewSplit.checked = true;
    } else {
      diffViewUnified.checked = true;
    }
  }

  // Load diff mode setting (checkbox toggle)
  const diffModeShifted = document.getElementById('diffModeShifted');
  if (diffModeShifted) {
    diffModeShifted.checked = (diffMode === 'shifted');
  }

  // Load compare mode setting (radio buttons)
  const compareModeCurrent = document.getElementById('compareModeCurrent');
  const compareModePrevious = document.getElementById('compareModePrevious');
  if (compareModeCurrent && compareModePrevious) {
    if (compareToCurrent) {
      compareModeCurrent.checked = true;
    } else {
      compareModePrevious.checked = true;
    }
  }

  // Load diff style setting
  const diffStyleSelect = document.getElementById('diffStyle');
  if (diffStyleSelect) {
    diffStyleSelect.value = currentDiffStyle;
  }

  // Add keyboard navigation
  document.addEventListener('keydown', handleKeyboardNavigation);

  // Inject diff styling for rounded corners
  injectDiffStyle();
  injectDarkModeButtonStyles();
  injectLightModeButtonStyles();
  injectSelectedColorStyle();
  injectHoverStyles();

  // Initialize Holiday Mode from localStorage
  initHolidayMode();

  // Initialize the view
  switchMode(currentMode);
});

function injectDiffStyle() {
  const styleId = 'diff-corner-style';
  let styleElement = document.getElementById(styleId);
  if (!styleElement) {
    styleElement = document.createElement('style');
    styleElement.id = styleId;
    document.head.appendChild(styleElement);
  }
  styleElement.textContent = `
        .diff-view-container,
        .unified-diff {
          border-radius: 8px;
          overflow: hidden;
        }
        
        /* Default: no rounded corners for inner elements */
        .diff-view-container > *,
        .unified-diff > * {
          border-radius: 0;
        }

        /* Round top corners of first element */
        .diff-view-container > :first-child,
        .unified-diff > :first-child {
          border-top-left-radius: 8px;
          border-top-right-radius: 8px;
        }

        /* Round bottom corners of last element */
        .diff-view-container > :last-child,
        .unified-diff > :last-child {
          border-bottom-left-radius: 8px;
          border-bottom-right-radius: 8px;
        }
      `;
}

function setTheme(theme) {
  const isDark = theme === 'dark';
  if (isDark) {
    document.body.classList.add('dark-mode');
    localStorage.setItem('darkMode', 'true');
  } else {
    document.body.classList.remove('dark-mode');
    localStorage.setItem('darkMode', 'false');
  }

  // Update button styles
  const darkModeStyle = document.getElementById('dark-mode-button-style');
  const lightModeStyle = document.getElementById('light-mode-button-style');
  const hoverStyle = document.getElementById('hover-style');

  if (darkModeStyle) darkModeStyle.remove();
  if (lightModeStyle) lightModeStyle.remove();
  if (hoverStyle) hoverStyle.remove();

  injectDarkModeButtonStyles();
  injectLightModeButtonStyles();
  injectHoverStyles();

  // Re-apply Picasso colors if needed (for dark mode overrides)
  const primaryColor = document.getElementById('picassoPrimaryColor').value;
  const secondaryColor = document.getElementById('picassoSecondaryColor').value;
  applyPicassoColors(primaryColor, secondaryColor);
}


function injectDarkModeButtonStyles() {
  const styleId = 'dark-mode-button-style';
  let styleElement = document.getElementById(styleId);
  if (!styleElement) {
    styleElement = document.createElement('style');
    styleElement.id = styleId;
    document.head.appendChild(styleElement);
  }
  styleElement.textContent = `
    body.dark-mode .file-history-actions .btn:not(:disabled) {
      background: #363636 !important;
      background-color: #363636 !important;
      color: #666666 !important;
    }
  `;
}

function injectLightModeButtonStyles() {
  const styleId = 'light-mode-button-style';
  let styleElement = document.getElementById(styleId);
  if (!styleElement) {
    styleElement = document.createElement('style');
    styleElement.id = styleId;
    document.head.appendChild(styleElement);
  }
  styleElement.textContent = `
    body:not(.dark-mode) .file-history-actions .btn:not(:disabled) {
      background: white !important;
      background-color: white !important;
      color: #CCCCCC !important;
    }
  `;
}

function injectSelectedColorStyle() {
  const styleId = 'selected-color-style';
  let styleElement = document.getElementById(styleId);
  if (!styleElement) {
    styleElement = document.createElement('style');
    styleElement.id = styleId;
    document.head.appendChild(styleElement);
  }
  styleElement.textContent = `
    .selected, .keyboard-selected {
      background-color: var(--accent-light) !important;
      color: var(--text-primary);
      border: 1px solid var(--accent-primary) !important;
    }
    .file-name {
      color: var(--text-primary);
    }
  `;
}

function injectHoverStyles() {
  const styleId = 'hover-style';
  let styleElement = document.getElementById(styleId);
  if (!styleElement) {
    styleElement = document.createElement('style');
    styleElement.id = styleId;
    document.head.appendChild(styleElement);
  }

  const isDarkMode = document.body.classList.contains('dark-mode');
  const hoverColor = isDarkMode ? '#262626' : '#f9f9f9';

  styleElement.textContent = `
    .file:not(.selected):not(.keyboard-selected):hover,
    .commit:not(.selected):not(.keyboard-selected):hover {
      background-color: ${hoverColor} !important;
    }
  `;
}



function applyPicassoColors(primaryColor, secondaryColor) {
  // Debug logging
  console.log('[Picasso Mode] Applying colors:', { primaryColor, secondaryColor });

  // Update CSS variables for accent colors only (not text or borders)
  const root = document.documentElement;

  // Primary color = GREEN (success/restore buttons)
  root.style.setProperty('--success', primaryColor, 'important');
  root.style.setProperty('--success-hover', primaryColor, 'important');
  root.style.setProperty('--success-light', `${primaryColor}40`, 'important');

  // Secondary color = BLUE (accent buttons, toggles, links)
  root.style.setProperty('--accent-primary', secondaryColor, 'important');
  root.style.setProperty('--accent-hover', secondaryColor, 'important');
  root.style.setProperty('--accent-light', `${secondaryColor}40`, 'important');

  // Verify what was set
  console.log('[Picasso Mode] CSS Variables set:', {
    'accent-primary': getComputedStyle(root).getPropertyValue('--accent-primary'),
    'accent-hover': getComputedStyle(root).getPropertyValue('--accent-hover'),
    'success': getComputedStyle(root).getPropertyValue('--success'),
    'success-hover': getComputedStyle(root).getPropertyValue('--success-hover')
  });

  // Also update dark mode specific variables if dark mode is active
  if (document.body.classList.contains('dark-mode')) {
    const darkModeStyle = document.getElementById('picasso-dark-mode-override');
    if (!darkModeStyle) {
      const style = document.createElement('style');
      style.id = 'picasso-dark-mode-override';
      document.head.appendChild(style);
    }
    document.getElementById('picasso-dark-mode-override').textContent = `
      body.dark-mode {
        --accent-primary: ${secondaryColor} !important;
        --accent-hover: ${secondaryColor} !important;
        --accent-light: ${secondaryColor}40 !important;
        --success: ${primaryColor} !important;
        --success-hover: ${primaryColor} !important;
        --success-light: ${primaryColor}40 !important;
      }
    `;
  }
}

function resetToDefaultColors() {
  // Reset to default color values (only accent colors)
  const root = document.documentElement;
  root.style.removeProperty('--accent-primary');
  root.style.removeProperty('--accent-hover');
  root.style.removeProperty('--accent-light');
  root.style.removeProperty('--success');
  root.style.removeProperty('--success-hover');
  root.style.removeProperty('--success-light');

  // Remove dark mode override
  const darkModeStyle = document.getElementById('picasso-dark-mode-override');
  if (darkModeStyle) {
    darkModeStyle.remove();
  }

  // Remove light mode override
  const lightModeStyle = document.getElementById('picasso-light-mode-override');
  if (lightModeStyle) {
    lightModeStyle.remove();
  }
}

function resetPicassoColors() {
  // Reset color pickers to defaults
  const defaultPrimary = '#10b981';
  const defaultSecondary = '#3b82f6';

  document.getElementById('picassoPrimaryColor').value = defaultPrimary;
  document.getElementById('picassoSecondaryColor').value = defaultSecondary;

  localStorage.setItem('picassoPrimaryColor', defaultPrimary);
  localStorage.setItem('picassoSecondaryColor', defaultSecondary);

  applyPicassoColors(defaultPrimary, defaultSecondary);

  // Update palette selection visual state
  updatePaletteSelection(defaultPrimary, defaultSecondary);
}

const PICASSO_PALETTE = [
  { name: 'User 1', primary: '#c4ba52', secondary: '#00abab' },
  { name: 'User 2', primary: '#77bb41', secondary: '#006d8f' },
  { name: 'User 3', primary: '#539eaf', secondary: '#ffb43f' },
  { name: 'User 4', primary: '#10b981', secondary: '#3b82f6' },
  { name: 'Royal', primary: '#4A00E0', secondary: '#8E2DE2' },
  { name: 'Forest', primary: '#16A085', secondary: '#F39C12' },
  { name: 'Ocean', primary: '#2193b0', secondary: '#6dd5ed' }
];

function initializeColorPalettes() {
  const container = document.getElementById('combinedPaletteContainer');
  console.log('[App] initializeColorPalettes called. Container:', container);

  if (!container) {
    console.error('[App] Palette container not found!');
    return;
  }

  container.innerHTML = '';
  console.log('[App] Generating palette items. Count:', PICASSO_PALETTE.length);

  PICASSO_PALETTE.forEach(item => {
    const circle = document.createElement('div');
    circle.className = 'color-circle not-selected';
    // Only set the background gradient inline (dynamic content)
    // Let CSS handle all the circular styling
    // Use explicit color stops for crisp edge
    circle.style.backgroundImage = `linear-gradient(to bottom, ${item.primary} 0%, ${item.primary} 50%, ${item.secondary} 50%, ${item.secondary} 100%)`;
    circle.style.backgroundOrigin = 'border-box';
    circle.style.backgroundRepeat = 'no-repeat';
    circle.style.backgroundSize = '100% 100%';
    circle.dataset.primary = item.primary;
    circle.dataset.secondary = item.secondary;

    circle.onclick = () => {
      const primaryInput = document.getElementById('picassoPrimaryColor');
      const secondaryInput = document.getElementById('picassoSecondaryColor');

      primaryInput.value = item.primary;
      secondaryInput.value = item.secondary;

      // Trigger input events manually
      primaryInput.dispatchEvent(new Event('input'));
      secondaryInput.dispatchEvent(new Event('input'));

      // Update visual selection
      updatePaletteSelection(item.primary, item.secondary);
    };

    container.appendChild(circle);
  });
}

function updatePaletteSelection(primary, secondary) {
  const container = document.getElementById('combinedPaletteContainer');
  if (!container) return;

  // Normalize color for comparison (simple check)
  const normalizeColor = (c) => {
    const d = document.createElement('div');
    d.style.color = c;
    return d.style.color;
  };

  const targetPrimary = normalizeColor(primary);
  const targetSecondary = normalizeColor(secondary);

  Array.from(container.children).forEach(circle => {
    const circlePrimary = normalizeColor(circle.dataset.primary);
    const circleSecondary = normalizeColor(circle.dataset.secondary);

    if (circlePrimary === targetPrimary && circleSecondary === targetSecondary) {
      circle.classList.add('selected');
      circle.classList.remove('not-selected');
    } else {
      circle.classList.remove('selected');
      circle.classList.add('not-selected');
    }
  });
}

// Button position management functions
function updateConfirmRestoreButtonPosition() {
  const button = document.getElementById('floatingConfirmRestore');
  if (button) {
    button.style.bottom = buttonPosition.y + 'px';
    button.style.right = buttonPosition.x + 'px';
    button.style.left = 'auto'; // Reset left to ensure right positioning works
  }
}

function showFloatingConfirmRestoreButton() {
  const button = document.getElementById('floatingConfirmRestore');
  if (button) {
    button.style.display = 'block';
    updateConfirmRestoreButtonPosition();
  }
}

function hideFloatingConfirmRestoreButton() {
  const button = document.getElementById('floatingConfirmRestore');
  if (button) {
    button.style.display = 'none';
  }
}

function moveConfirmRestoreButton(direction) {
  const step = 10; // Move 10px per arrow click
  const maxOffset = 1000; // Maximum offset from edges

  switch (direction) {
    case 'up':
      buttonPosition.y = Math.max(5, buttonPosition.y - step);
      break;
    case 'down':
      buttonPosition.y = Math.min(maxOffset, buttonPosition.y + step);
      break;
    case 'left':
      buttonPosition.x = Math.min(maxOffset, buttonPosition.x + step);
      break;
    case 'right':
      buttonPosition.x = Math.max(5, buttonPosition.x - step);
      break;
  }

  // Save to localStorage
  localStorage.setItem('confirmRestoreBtnX', buttonPosition.x.toString());
  localStorage.setItem('confirmRestoreBtnY', buttonPosition.y.toString());

  // Update button position
  updateConfirmRestoreButtonPosition();

  // Show position info
  // showNotification(`Position: ${buttonPosition.x}px from right, ${buttonPosition.y}px from bottom`, 'success', 1000);
}

function createArrowControls() {
  const arrowControls = document.createElement('div');
  arrowControls.id = 'arrowControls';
  arrowControls.className = 'arrow-controls';
  arrowControls.innerHTML = `
  < div class="arrow-control-title" > ${t('restore_preview.move_button_title')}</div >
        <div class="arrow-pad">
          <button class="arrow-btn arrow-up" onclick="moveConfirmRestoreButton('up')" title="${t('restore_preview.move_up')}">▲</button>
          <div class="arrow-middle-row">
            <button class="arrow-btn arrow-left" onclick="moveConfirmRestoreButton('left')" title="${t('restore_preview.move_left')}">◀</button>
            <button class="arrow-btn arrow-center" disabled>●</button>
            <button class="arrow-btn arrow-right" onclick="moveConfirmRestoreButton('right')" title="${t('restore_preview.move_right')}">▶</button>
          </div>
          <button class="arrow-btn arrow-down" onclick="moveConfirmRestoreButton('down')" title="${t('restore_preview.move_down')}">▼</button>
        </div>
        <div class="arrow-control-info">
          X: ${buttonPosition.x}px | Y: ${buttonPosition.y}px
        </div>
`;
  document.body.appendChild(arrowControls);
}

// Keyboard navigation functions

function handleKeyboardNavigation(event) {
  // Only handle arrow keys when not typing in an input
  if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') {
    return;
  }

  // Don't navigate if no items available
  if (keyboardNav.items.length === 0) {
    return;
  }

  let newIndex = keyboardNav.selectedIndex;

  if (event.key === 'ArrowDown') {
    event.preventDefault();
    // If no selection yet, start at 0, otherwise move down
    newIndex = keyboardNav.selectedIndex < 0 ? 0 : Math.min(keyboardNav.selectedIndex + 1, keyboardNav.items.length - 1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    // If no selection yet, start at last item, otherwise move up
    newIndex = keyboardNav.selectedIndex < 0 ? keyboardNav.items.length - 1 : Math.max(keyboardNav.selectedIndex - 1, 0);
  } else if (event.key === 'ArrowRight' && keyboardNav.currentList === 'files') {
    // Right arrow in Files tab - navigate into folder
    event.preventDefault();
    const selectedItem = keyboardNav.items[keyboardNav.selectedIndex];
    if (selectedItem && selectedItem.onclick) {
      const onclickStr = selectedItem.getAttribute('onclick');
      // Check if it's a folder (navigateToPath) vs file (showFileHistory)
      if (onclickStr && onclickStr.includes('navigateToPath')) {
        selectedItem.onclick();
      }
    }
    return;
  } else if (event.key === 'ArrowLeft' && keyboardNav.currentList === 'files') {
    // Left arrow in Files tab - go back up one level
    event.preventDefault();
    if (currentFilePath) {
      // Navigate to parent folder
      const parts = currentFilePath.split('/');
      parts.pop(); // Remove last part
      const parentPath = parts.join('/');
      navigateToPath(parentPath);
    }
    return;
  } else if (event.key === 'Enter' && keyboardNav.selectedIndex >= 0) {
    event.preventDefault();
    // Trigger click on the selected item
    const selectedItem = keyboardNav.items[keyboardNav.selectedIndex];
    if (selectedItem && selectedItem.onclick) {
      // In Files tab, don't navigate into folders with Enter - only show file history
      if (keyboardNav.currentList === 'files') {
        const onclickStr = selectedItem.getAttribute('onclick');
        // Only trigger onclick if it's NOT a folder navigation
        if (onclickStr && !onclickStr.includes('navigateToPath')) {
          selectedItem.onclick();
        }
      } else {
        // For other tabs, trigger onclick normally
        selectedItem.onclick();
      }
    }
    return;
  } else {
    return; // Not an arrow key or Enter
  }

  // Navigate and select the item
  // In Files tab, don't auto-trigger click for folders to avoid auto-navigating into folders
  // But DO triggering click for files so they can be previewed
  let shouldTriggerClick = keyboardNav.currentList !== 'files';

  if (keyboardNav.currentList === 'files' && keyboardNav.items[newIndex]) {
    // Only trigger click if it is NOT a folder
    // Folders have the .folder-chevron class
    const isFolder = keyboardNav.items[newIndex].querySelector('.folder-chevron');
    if (!isFolder) {
      shouldTriggerClick = true;
    }
  }

  selectListItem(newIndex, shouldTriggerClick);
}


function selectListItem(index, triggerClick = false) {
  // Clear previous selection
  if (keyboardNav.selectedIndex >= 0 && keyboardNav.items[keyboardNav.selectedIndex]) {
    keyboardNav.items[keyboardNav.selectedIndex].classList.remove('keyboard-selected');
    // Remove selected class if exists
    keyboardNav.items[keyboardNav.selectedIndex].classList.remove('selected');
  }

  // Update index
  keyboardNav.selectedIndex = index;

  // Apply new selection only if index is valid
  if (index >= 0 && keyboardNav.items[index]) {
    keyboardNav.items[index].classList.add('keyboard-selected');

    // Scroll into view
    keyboardNav.items[index].scrollIntoView({
      block: 'nearest',
      behavior: 'smooth'
    });

    // Trigger click if specified (for arrow key navigation)
    if (triggerClick && keyboardNav.items[index].onclick) {
      keyboardNav.items[index].onclick();
    }
  }
}

function updateKeyboardNavState(listType, items) {
  keyboardNav.currentList = listType;
  keyboardNav.items = items;
  keyboardNav.selectedIndex = -1; // Changed from 0 to -1

  // Remove automatic selection on first item
  // Only apply keyboard-selected class when user actually uses keyboard navigation
}

function clearKeyboardSelection() {
  keyboardNav.items.forEach(item => {
    item.classList.remove('keyboard-selected');
  });
  keyboardNav.selectedIndex = -1;
}

// Font management
function cycleFont() {
  const currentIndex = fontOptions.findIndex(f => f.name === currentFont);
  const nextIndex = (currentIndex + 1) % fontOptions.length;
  currentFont = fontOptions[nextIndex].name;
  localStorage.setItem('diffFont', currentFont);
  updateFontButton();
  applyFontToDiffs();
  // showNotification(`Font: ${currentFont} `, 'success', 1500);
}

function updateFontButton() {
  const button = document.getElementById('fontButton');
  if (button) {
    const currentIndex = fontOptions.findIndex(f => f.name === currentFont);
    const nextIndex = (currentIndex + 1) % fontOptions.length;
    const nextFont = fontOptions[nextIndex].name;
    button.innerHTML = `< span class="font-indicator" > ${currentFont}</span > `;
    button.title = `Current: ${currentFont} (Click to change to: ${nextFont})`;
  }
}

function applyFontToDiffs() {
  const selectedFont = fontOptions.find(f => f.name === currentFont);
  const selectedSize = fontSizeOptions.find(s => s.size === currentFontSize);
  if (selectedFont && selectedSize) {
    // Update all diff-related CSS classes
    const styleId = 'diff-font-style';
    let styleElement = document.getElementById(styleId);
    if (!styleElement) {
      styleElement = document.createElement('style');
      styleElement.id = styleId;
      document.head.appendChild(styleElement);
    }
    styleElement.textContent = `
  .diff - content,
          .diff - column.diff - content,
          .unified - diff.diff - content,
          .diff - view - container {
  font - family: ${selectedFont.stack} !important;
  font - size: ${selectedSize.size} !important;
}
`;
  }
}

// Font size management
function cycleFontSize() {
  const currentIndex = fontSizeOptions.findIndex(s => s.size === currentFontSize);
  const nextIndex = (currentIndex + 1) % fontSizeOptions.length;
  currentFontSize = fontSizeOptions[nextIndex].size;
  localStorage.setItem('diffFontSize', currentFontSize);
  updateFontSizeButton();
  applyFontToDiffs();
  // showNotification(`Font size: ${fontSizeOptions[nextIndex].name} `, 'success', 1500);
}

function updateFontSizeButton() {
  const button = document.getElementById('fontSizeButton');
  if (button) {
    const currentIndex = fontSizeOptions.findIndex(s => s.size === currentFontSize);
    const nextIndex = (currentIndex + 1) % fontSizeOptions.length;
    const nextSize = fontSizeOptions[nextIndex].name;
    button.innerHTML = `<span class="size-indicator">${fontSizeOptions[currentIndex].name}</span>`;
    button.title = `Current: ${fontSizeOptions[currentIndex].name} (Click to change to: ${nextSize})`;
  }
}

// Diff style management
function switchDiffStyle(styleId) {
  currentDiffStyle = styleId;
  localStorage.setItem('diffStyle', styleId);

  // Instantly update the visual style without re-rendering
  const diffShell = document.querySelector('.diff-viewer-shell');
  const bannersGrid = document.querySelector('.diff-banners-grid');

  if (diffShell) {
    // Remove all style classes
    diffStyleOptions.forEach(style => {
      diffShell.classList.remove(style.id);
      if (bannersGrid) {
        bannersGrid.classList.remove(style.id);
      }
    });
    // Add the new style class
    diffShell.classList.add(styleId);
    if (bannersGrid) {
      bannersGrid.classList.add(styleId);
    }
  }

  const styleName = diffStyleOptions.find(s => s.id === styleId)?.name || styleId;
  // showNotification(`Diff style: ${styleName}`, 'success', 1500);
}

function toggleDiffViewFormat(isSplit) {
  const newFormat = isSplit ? 'split' : 'unified';
  diffViewFormat = newFormat;
  localStorage.setItem('diffViewFormat', newFormat);
  // showNotification(`Diff view: ${isSplit ? 'Side-by-Side' : 'Unified'}`, 'success', 1500);

  // Re-render the currently displayed view
  refreshCurrentView();
}

function toggleDiffMode(isChecked) {
  const mode = isChecked ? 'shifted' : 'standard';
  diffMode = mode;
  localStorage.setItem('diffMode', mode);

  // Refresh the current view to apply new diff mode
  refreshCurrentView();
}

function setCompareMode(mode) {
  const isCurrent = (mode === 'current');
  compareToCurrent = isCurrent;
  localStorage.setItem('compareToCurrent', isCurrent);

  // Auto-update diffMode based on comparison type
  // Current -> Shifted (Changes First)
  // Previous -> Standard (Normal Diff)
  const newDiffMode = isCurrent ? 'shifted' : 'standard';
  diffMode = newDiffMode;
  localStorage.setItem('diffMode', newDiffMode);

  // Refresh the current view to apply new setting
  refreshCurrentView();
}

function refreshCurrentView() {
  if (!currentSelection) return;

  if (currentSelection.type === 'commit') {
    showCommit(currentSelection.hash);
  } else if (currentSelection.type === 'file') {
    if (currentFileHistory && currentFileHistory.length > 0) {
      displayFileHistory(currentSelection.file);
    } else {
      // No history or unchanged state - need to re-fetch to get content for unchanged view
      showFileHistory(currentSelection.file);
    }
  } else if (currentSelection.type === 'automation') {
    if (currentAutomationHistory && currentAutomationHistory.length > 0) {
      displayAutomationHistory();
    } else {
      showAutomationHistory(currentSelection.id);
    }
  } else if (currentSelection.type === 'script') {
    if (currentScriptHistory && currentScriptHistory.length > 0) {
      displayScriptHistory();
    } else {
      showScriptHistory(currentSelection.id);
    }
  }
}


// Settings modal functions
function openSettings() {
  const settingsModal = document.getElementById('settingsModal');

  document.getElementById('settingsModal').classList.add('active');
}

function closeSettings() {
  document.getElementById('settingsModal').classList.remove('active');
}

async function saveSettings() {
  // Get settings values
  const darkMode = document.getElementById('themeDark').checked;
  const debounceTime = document.getElementById('debounceTime').value;
  const debounceTimeUnit = document.getElementById('debounceTimeUnit').value;

  const retentionType = 'time'; // Hardcoded as UI option removed
  const retentionValue = document.getElementById('retentionValue').value;
  const retentionUnit = document.getElementById('retentionUnit').value;
  const historyRetention = document.getElementById('historyRetention').checked;
  const diffViewSplit = document.getElementById('diffViewSplit').checked;
  const newDiffViewFormat = diffViewSplit ? 'split' : 'unified';
  const newDiffStyle = document.getElementById('diffStyle').value;

  // Save to localStorage
  localStorage.setItem('darkMode', darkMode);
  localStorage.setItem('debounceTime', debounceTime);
  localStorage.setItem('debounceTimeUnit', debounceTimeUnit);

  localStorage.setItem('retentionType', retentionType);
  localStorage.setItem('retentionValue', retentionValue);
  localStorage.setItem('retentionUnit', retentionUnit);
  localStorage.setItem('historyRetention', historyRetention);
  localStorage.setItem('diffViewFormat', newDiffViewFormat);
  localStorage.setItem('diffStyle', newDiffStyle);

  // Update the global variables
  diffViewFormat = newDiffViewFormat;
  currentDiffStyle = newDiffStyle;

  // Save to server
  try {
    const response = await fetch(`${API}/runtime-settings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        debounceTime,
        debounceTimeUnit,
        historyRetention,
        retentionType,
        retentionValue,
        retentionUnit
      })
    });

    if (response.ok) {
      console.log('Settings saved to server');
      // showNotification(t('app.settings_saved'), 'success', 1500);
    } else {
      console.error('Failed to save settings to server');
      showNotification(t('app.settings_save_error'), 'error', 3000);
    }
  } catch (error) {
    console.error('Error saving settings to server:', error);
    showNotification(t('app.settings_save_error_generic'), 'error', 3000);
  }

  // Re-render current view to apply changes immediately
  refreshCurrentView();

  // Settings saved - close modal
  closeSettings();

  // Update UI state based on new settings
  handleRetentionToggle();
}

function handleRetentionToggle() {
  const historyRetention = document.getElementById('historyRetention');
  const retentionOptions = document.getElementById('retentionOptions');

  if (historyRetention && retentionOptions) {
    retentionOptions.style.display = historyRetention.checked ? 'block' : 'none';
  }
}



function toggleDarkMode() {
  const darkModeToggle = document.getElementById('darkModeToggle');
  const isDark = darkModeToggle.checked;

  if (isDark) {
    document.body.classList.add('dark-mode');
    localStorage.setItem('darkMode', 'true');
  } else {
    document.body.classList.remove('dark-mode');
    localStorage.setItem('darkMode', 'false');
  }

  injectHoverStyles();
}

// Date grouping logic
function getDateBucket(dateString) {
  const date = new Date(dateString);
  const now = new Date();

  // Reset times to compare dates only
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);

  const commitDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  // 1. Today
  if (commitDate.getTime() === today.getTime()) {
    return t('date_buckets.today');
  }

  // 2. Yesterday
  if (commitDate.getTime() === yesterday.getTime()) {
    return t('date_buckets.yesterday');
  }

  // 3. This Week (Last 7 days, excluding Today/Yesterday)
  if (commitDate > weekAgo) {
    return t('date_buckets.this_week');
  }

  // 4. This Month (Same month/year, excluding last week)
  if (date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear()) {
    return t('date_buckets.this_month');
  }

  // 5. Current Year -> Month Name (e.g. November)
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleString('default', { month: 'long' });
  }

  // 6. Previous Years -> Year (e.g. 2024)
  return date.getFullYear().toString();
}

function groupCommitsByDate(commits) {
  const groups = {};
  const bucketOrder = []; // Keep track of the order we see buckets

  commits.forEach(commit => {
    const bucket = getDateBucket(commit.date);
    if (!groups[bucket]) {
      groups[bucket] = [];
      bucketOrder.push(bucket); // Add new bucket to order list
    }
    groups[bucket].push(commit);
  });

  return { groups, bucketOrder };
}

function formatDateDisplay(bucket) {
  if (bucket === t('date_buckets.today')) {
    return t('date_buckets.today');
  } else if (bucket === t('date_buckets.yesterday')) {
    return t('date_buckets.yesterday');
  } else if (bucket === t('date_buckets.this_week')) {
    return t('date_buckets.this_week');
  } else {
    return t('date_buckets.earlier');
  }
}

function formatDateForLabel(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
}

// File path utilities

function parseFilePath(filePath) {
  const parts = filePath.split('/');
  const fileName = parts.pop();
  const directory = parts.join('/');
  return { fileName, directory, parts };
}

function createBreadcrumb(filePath) {
  const { fileName, directory, parts } = parseFilePath(filePath);

  if (!directory) {
    return `<span class="breadcrumb-current">${fileName}</span>`;
  }

  let html = '';

  // Add root config (or first part)
  html += `<span class="breadcrumb-item clickable" onclick="navigateToPath('')">${parts[0]}</span>`;

  // Add intermediate directories
  for (let i = 1; i < parts.length; i++) {
    const pathUpToHere = parts.slice(0, i + 1).join('/');
    html += `<span class="breadcrumb-separator">/</span>`;
    html += `<span class="breadcrumb-item clickable" onclick="navigateToPath('${pathUpToHere}')">${parts[i]}</span>`;
  }

  // Add file name
  html += `<span class="breadcrumb-separator">/</span>`;
  html += `<span class="breadcrumb-current">${fileName}</span>`;

  return html;
}

// Search functionality
let searchTimeout = null;

function handleSearch(event) {
  const query = event.target.value.toLowerCase();
  const clearBtn = document.getElementById('clearBtn');

  if (query) {
    clearBtn.style.display = 'block';
  } else {
    clearBtn.style.display = 'none';
  }

  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(async () => {
    if (currentMode === 'timeline') {
      await filterCommits(query);
    } else if (currentMode === 'files') {
      filterFiles(query);
    } else if (currentMode === 'automations') {
      filterAutomations(query);
    } else if (currentMode === 'scripts') {
      filterScripts(query);
    }
  }, 300);
}

async function clearSearch() {
  const searchInput = document.getElementById('searchInput');
  const clearBtn = document.getElementById('clearBtn');
  const searchInfo = document.getElementById('searchInfo');

  searchInput.value = '';
  clearBtn.style.display = 'none';
  searchInfo.textContent = '';

  if (currentMode === 'timeline') {
    await displayCommits(allCommits);
  } else if (currentMode === 'files') {
    displayFileList(allFiles);
  } else if (currentMode === 'automations') {
    displayAutomations(allAutomations);
  } else if (currentMode === 'scripts') {
    displayScripts(allScripts);
  }
}

async function filterCommits(query) {
  if (!query) {
    await displayCommits(allCommits);
    return;
  }

  const filtered = allCommits.filter(commit =>
    commit.message.toLowerCase().includes(query)
  );

  await displayCommits(filtered);
}

function filterFiles(query) {
  if (!query) {
    displayFileList(allFiles);
    return;
  }

  const filtered = allFiles.filter(fileObj => {
    // Handle both string paths (legacy) and object paths (new format)
    const filePath = typeof fileObj === 'string' ? fileObj : fileObj.path;
    return filePath.toLowerCase().includes(query);
  });

  displayFileList(filtered);
}

function filterAutomations(query) {
  if (!query) {
    displayAutomations(allAutomations);
    return;
  }

  const filtered = allAutomations.filter(auto =>
    auto.name.toLowerCase().includes(query) ||
    auto.file.toLowerCase().includes(query)
  );

  displayAutomations(filtered);
}

function filterScripts(query) {
  if (!query) {
    displayScripts(allScripts);
    return;
  }

  const filtered = allScripts.filter(script =>
    script.name.toLowerCase().includes(query) ||
    script.file.toLowerCase().includes(query)
  );

  displayScripts(filtered);
}

function navigateToPath(path) {
  // Navigate to a folder path
  if (!path) {
    // Go back to root
    currentFilePath = '';
    displayFileList(allFiles);
    return;
  }

  // Update current path and display
  currentFilePath = path;
  displayFileList(allFiles);
}

function handleSortChange(value) {
  sortState[currentMode] = value;
  localStorage.setItem(`sort_${currentMode}`, value);

  // Reload current view to apply sort
  if (currentMode === 'files') loadFiles();
  else if (currentMode === 'automations') loadAutomations();
  else if (currentMode === 'scripts') loadScripts();
}

function sortItems(items, sortType) {
  const sorted = [...items];


  switch (sortType) {
    case 'name_asc':
      return sorted.sort((a, b) => {
        const nameA = (a.name || a.path || '').replace(/^\.+/, ''); // Strip leading dots for sorting
        const nameB = (b.name || b.path || '').replace(/^\.+/, ''); // Strip leading dots for sorting
        return nameA.localeCompare(nameB);
      });
    case 'name_desc':
      return sorted.sort((a, b) => {
        const nameA = (a.name || a.path || '').replace(/^\.+/, ''); // Strip leading dots for sorting
        const nameB = (b.name || b.path || '').replace(/^\.+/, ''); // Strip leading dots for sorting
        return nameB.localeCompare(nameA);
      });
    case 'recently_modified':
      return sorted.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
    default:
      return sorted;
  }
}

async function switchMode(mode) {
  currentMode = mode;
  currentSelection = null;

  // Hide the floating button when switching modes
  hideFloatingConfirmRestoreButton();

  // Update tabs
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById(`${mode}Tab`).classList.add('active');

  // Update panel title and show/hide sort controls
  const leftPanelTitle = document.getElementById('leftPanelTitle');
  const leftPanelActions = document.getElementById('leftPanelActions');
  const sortSelect = document.getElementById('sortSelect');
  const rightPanelTitle = document.getElementById('rightPanelTitle');
  const rightPanelActions = document.getElementById('rightPanelActions');

  // Reset right panel actions
  rightPanelActions.innerHTML = '';

  // Show/hide sort controls based on mode
  if (['files', 'automations', 'scripts'].includes(mode)) {
    leftPanelActions.style.display = 'block';

    // Ensure valid sort state for this mode (prevent selecting removed option)
    if ((mode === 'automations' || mode === 'scripts') && sortState[mode] === 'recently_modified') {
      sortState[mode] = 'default';
      localStorage.setItem(`sort_${mode}`, 'default');
    }

    sortSelect.value = sortState[mode];
  } else {
    leftPanelActions.style.display = 'none';
  }

  // Update search bar visibility and placeholder
  const searchContainer = document.getElementById('timelineSearch');
  const searchInput = document.getElementById('searchInput');
  searchContainer.style.display = 'flex';

  if (mode === 'timeline') {
    leftPanelTitle.textContent = t('timeline.title');
    leftPanelTitle.setAttribute('data-i18n', 'timeline.title');
    searchInput.placeholder = t('timeline.search_placeholder');
    searchInput.setAttribute('data-i18n', 'timeline.search_placeholder');
    // Clear title initially - it will be set when a commit is selected
    rightPanelTitle.textContent = '';
    rightPanelTitle.removeAttribute('data-i18n');
    await loadTimeline();
  }

  // Handle sort options visibility
  let dateDescOption = sortSelect.querySelector('option[value="recently_modified"]');
  let defaultOption = sortSelect.querySelector('option[value="default"]');

  if (mode === 'automations' || mode === 'scripts') {
    // AUTOMATIONS / SCRIPTS MODE

    // 1. Remove "Recently Modified"
    if (dateDescOption) {
      dateDescOption.remove();
    }

    // 2. Ensure "Default" exists (add back if missing)
    if (!defaultOption) {
      const newOption = document.createElement('option');
      newOption.value = 'default';
      newOption.textContent = t('sort.default');
      newOption.setAttribute('data-i18n', 'sort.default');
      sortSelect.insertBefore(newOption, sortSelect.firstChild);
    }

    // 3. Validate current selection
    // Only force change if the current selection is invalid (recently_modified)
    // We respect 'default', 'name_asc', 'name_desc' if the user chose them
    if (sortSelect.value === 'recently_modified') {
      const newValue = 'name_asc';
      sortSelect.value = newValue;
      sortState[mode] = newValue;
      localStorage.setItem(`sort_${mode}`, newValue);
    }

  } else {
    // FILES MODE (and others)

    // 1. Remove "Default"
    if (defaultOption) {
      defaultOption.remove();
    }

    // 2. Ensure "Recently Modified" exists (add back if missing)
    if (!dateDescOption) {
      const newOption = document.createElement('option');
      newOption.value = 'recently_modified';
      newOption.textContent = t('sort.recently_modified');
      newOption.setAttribute('data-i18n', 'sort.recently_modified');
      sortSelect.appendChild(newOption);
    }

    // 3. Validate current selection
    // Only force change if the current selection is invalid (default)
    // We respect 'recently_modified', 'name_asc', 'name_desc' if the user chose them
    if (sortSelect.value === 'default') {
      const newValue = 'recently_modified';
      sortSelect.value = newValue;
      sortState[mode] = newValue;
      localStorage.setItem(`sort_${mode}`, newValue);
    }
  }

  if (mode === 'files') {
    leftPanelTitle.textContent = t('files.title');
    leftPanelTitle.setAttribute('data-i18n', 'files.title');
    searchInput.placeholder = t('files.search_placeholder');
    searchInput.setAttribute('data-i18n', 'files.search_placeholder');
    rightPanelTitle.textContent = t('files.file_history');
    rightPanelTitle.setAttribute('data-i18n', 'files.file_history');
    await loadFiles();
  } else if (mode === 'automations') {
    leftPanelTitle.textContent = t('automations.title');
    leftPanelTitle.setAttribute('data-i18n', 'automations.title');
    searchInput.placeholder = t('automations.search_placeholder');
    searchInput.setAttribute('data-i18n', 'automations.search_placeholder');
    rightPanelTitle.textContent = t('automations.automation_history');
    rightPanelTitle.setAttribute('data-i18n', 'automations.automation_history');
    await loadAutomations();
  } else if (mode === 'scripts') {
    leftPanelTitle.textContent = t('scripts.title');
    leftPanelTitle.setAttribute('data-i18n', 'scripts.title');
    searchInput.placeholder = t('scripts.search_placeholder');
    searchInput.setAttribute('data-i18n', 'scripts.search_placeholder');
    rightPanelTitle.textContent = t('scripts.script_history');
    rightPanelTitle.setAttribute('data-i18n', 'scripts.script_history');
    await loadScripts();
  }

  // Clear search input when switching modes
  searchInput.value = '';
  const clearBtn = document.getElementById('clearBtn');
  const searchInfo = document.getElementById('searchInfo');
  if (clearBtn) clearBtn.style.display = 'none';
  if (searchInfo) searchInfo.textContent = '';

  // Clear right panel
  let emptyTextKey = `${mode}.select_item`;
  if (mode === 'timeline') {
    emptyTextKey = 'timeline.select_version';
  }
  document.getElementById('rightPanel').innerHTML = `<div class="empty" data-i18n="${emptyTextKey}">${t(emptyTextKey)}</div>`;
  updateStaticText();
}

function refreshCurrent() {
  if (currentMode === 'timeline') {
    loadTimeline();
  } else if (currentMode === 'files') {
    loadFiles();
  } else if (currentMode === 'automations') {
    loadAutomations();
  } else if (currentMode === 'scripts') {
    loadScripts();
  }
}

async function loadTimeline() {
  try {
    const response = await fetch(`${API}/git/history`);
    const data = await response.json();

    if (data.success) {
      allCommits = data.log.all;
      await displayCommits(allCommits);
    }
  } catch (error) {
    console.error('Error:', error);
  }
}

function hasActualChanges(commit) {
  // Check if commit is a "Startup backup" with 0 files
  if (commit.message.includes('Startup backup') && commit.message.includes('0 files')) {
    return false;
  }

  // Check for "Auto-save" pattern with no actual file changes
  // The API doesn't provide direct info about file changes, so we use heuristics
  // If it's an "Auto-save" commit, we consider it as having changes
  // unless it's specifically marked as having 0 files
  if (commit.message.startsWith('Auto-save:')) {
    return true; // Keep auto-save commits
  }

  // For other commits (restores, manual saves, etc.), assume they have changes
  return true;
}

async function displayCommits(commits) {
  // Get the showChangedOnly setting based on current tab
  // Timeline: false (show all commits), Other tabs: true (show only files with changes)
  const showChangedOnly = currentMode !== 'timeline';

  // Filter commits if the setting is enabled
  let filteredCommits = commits;
  if (showChangedOnly) {
    // Show loading indicator
    document.getElementById('leftPanel').innerHTML = `<div class="empty" data-i18n="timeline.filtering_commits">${t('timeline.filtering_commits')}</div>`;

    // Filter out commits that clearly have no changes
    filteredCommits = commits.filter(commit => {
      // Remove "Startup backup" commits with 0 files
      if (commit.message.includes('Startup backup') && commit.message.includes('0 files')) {
        return false;
      }
      // Keep all other commits (Auto-save, Restore, etc.)
      return true;
    });

    // Now check each commit for actual content changes
    // This is expensive but ensures we only show commits with real changes
    console.log('[Filter] Checking commits for actual changes...');
    const commitsWithChanges = [];

    for (const commit of filteredCommits) {
      try {
        // Fetch commit details to get the list of files
        const response = await fetch(`${API}/git/commit-details?commitHash=${commit.hash}`);
        const data = await response.json();

        if (data.success) {
          // Parse files from status
          const lines = data.status.split('\n').filter(line => line.trim());
          const files = lines.slice(1).map(line => {
            const parts = line.split('\t');
            return { status: parts[0], file: parts[1] };
          }).filter(f => f.file);

          if (files.length === 0) {
            // No files changed, skip this commit
            console.log(`[Filter] Skipping ${commit.hash.substring(0, 8)}: no files`);
            continue;
          }

          // Check if any file has actual content changes
          let hasActualChanges = false;
          for (const file of files.slice(0, 5)) { // Check up to 5 files to limit API calls
            try {
              // Get current file content
              const currentResponse = await fetch(`${API}/file-content?filePath=${encodeURIComponent(file.file)}`);
              const currentData = await currentResponse.json();
              const currentContent = currentData.success ? currentData.content : '';

              // Get commit version content
              const commitResponse = await fetch(`${API}/git/file-at-commit?filePath=${encodeURIComponent(file.file)}&commitHash=${commit.hash}`);
              const commitData = await commitResponse.json();
              const commitContent = commitData.success ? commitData.content : '';

              // Compare contents
              if (currentContent !== commitContent) {
                hasActualChanges = true;
                break;
              }
            } catch (e) {
              // If we can't check the file, include the commit
              hasActualChanges = true;
              break;
            }
          }

          if (hasActualChanges) {
            commitsWithChanges.push(commit);
            console.log(`[Filter] Keeping ${commit.hash.substring(0, 8)}: has changes`);
          } else {
            console.log(`[Filter] Skipping ${commit.hash.substring(0, 8)}: no actual changes`);
          }
        } else {
          // If we can't get commit details, include it
          commitsWithChanges.push(commit);
        }
      } catch (error) {
        console.error(`[Filter] Error checking commit ${commit.hash}:`, error);
        // If error, include the commit to be safe
        commitsWithChanges.push(commit);
      }
    }

    filteredCommits = commitsWithChanges;
    console.log(`[Filter] Filtered ${commits.length} commits down to ${filteredCommits.length} with changes`);
  }

  const { groups, bucketOrder } = groupCommitsByDate(filteredCommits);

  let html = '';

  for (const bucket of bucketOrder) {
    if (groups[bucket] && groups[bucket].length > 0) {
      // For dynamic buckets (Month names), we display them as is
      // For static buckets (Today/Yesterday/...), formatDateDisplay handles translation if needed
      // But since our keys are already translated strings from getDateBucket, we can just use the bucket name
      const displayName = bucket;

      // Determine if expanded by default (Today, Yesterday, This Week)
      const isExpanded = [
        t('date_buckets.today'),
        t('date_buckets.yesterday'),
        t('date_buckets.this_week')
      ].includes(bucket);

      const collapsedClass = isExpanded ? '' : 'collapsed';

      html += `
            <div class="date-group">
              <div class="date-header ${collapsedClass}" onclick="toggleDateGroup('${bucket}')" id="header-${bucket}">
                ${displayName} (${groups[bucket].length})
              </div>
              <div class="date-content ${collapsedClass}" id="content-${bucket}">
          `;

      for (const commit of groups[bucket]) {
        const commitDate = new Date(commit.date);
        const timeString = commitDate.toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true
        });

        // Extract just the filename from the commit message
        let fileName = commit.message;

        // Try to extract filename from various commit message formats
        // Pattern 1: "file1.yaml, file2.yaml" (multiple files)
        if (commit.message.includes(',')) {
          // Keep the comma-separated list as-is
          fileName = commit.message;
        }
        // Pattern 2: "Auto-save: automations.yaml - timestamp"
        else if (commit.message.includes(' - ')) {
          const beforeDash = commit.message.split(' - ')[0];
          if (beforeDash.includes(':')) {
            fileName = beforeDash.split(':')[1].trim();
          } else {
            fileName = beforeDash;
          }
        }
        // Pattern 2: "Restore: filename.yaml to hash"
        else if (commit.message.startsWith('Restore: ') && commit.message.includes(' to ')) {
          const afterRestore = commit.message.substring('Restore: '.length);
          const beforeTo = afterRestore.split(' to ')[0];
          fileName = beforeTo.trim();
        }
        // Pattern 3: "Restore automation 'X' in filename.yaml to commit hash"
        else if (commit.message.includes(' in ')) {
          const match = commit.message.match(/ in ([^\s]+\.(yaml|yml|txt|json|py))/i);
          if (match) {
            fileName = match[1];
          }
        }
        // Pattern 4: "Merged history ISO_DATE"
        else if (commit.message.startsWith('Merged history ')) {
          const isoDate = commit.message.substring('Merged history '.length).trim();
          // User requested simple "Merged" text instead of full date
          fileName = 'Merged';
        }
        // Pattern 5: "Startup backup: timestamp (X files)"
        else if (commit.message.includes('(') && commit.message.includes(')')) {
          const match = commit.message.match(/\((\d+) files?\)/);
          if (match) {
            fileName = `${match[1]} files`;
          }
        }

        // Clean up status labels if present (e.g. "file.yaml (Added)")
        // This ensures the left panel shows clean filenames while the right panel shows status
        fileName = fileName.replace(/\s+\((Added|Deleted|Modified)\)$/i, '');

        // Remove surrounding quotes from filenames (e.g. "pizza-avocado 1 copy.yaml" becomes pizza-avocado 1 copy.yaml)
        fileName = fileName.replace(/^["']|["']$/g, '');

        html += `
              <div class="commit" onclick="showCommit('${commit.hash}')" id="commit-${commit.hash}">
                <div class="commit-time">${timeString}</div>
                <div class="commit-file">${fileName}</div>
              </div>
            `;
      }

      html += `
              </div>
            </div>
          `;
    }
  }

  document.getElementById('leftPanel').innerHTML = html;

  // Auto-select the first commit if nothing is selected (or if the selected one is filtered out)
  if (filteredCommits.length > 0) {
    let commitToSelect = filteredCommits[0].hash;

    // If we have a current selection that is still visible in the filtered list, keep it
    if (currentSelection && currentSelection.type === 'commit' && filteredCommits.some(c => c.hash === currentSelection.hash)) {
      commitToSelect = currentSelection.hash;
    }

    showCommit(commitToSelect);
  } else {
    document.getElementById('rightPanel').innerHTML = `<div class="empty">${t('timeline.select_commit')}</div>`;
    document.getElementById('rightPanelActions').innerHTML = '';
  }

  // Update keyboard navigation
  const commitItems = Array.from(document.querySelectorAll('.commit'));
  updateKeyboardNavState('commits', commitItems);

  // Hide the floating button when not viewing a diff
  hideFloatingConfirmRestoreButton();
}

function toggleDateGroup(bucket) {
  const header = document.getElementById(`header-${bucket}`);
  const content = document.getElementById(`content-${bucket}`);

  // Toggle class on parent group for spacing control
  if (header && header.parentElement) {
    header.parentElement.classList.toggle('collapsed');
  }

  header.classList.toggle('collapsed');
  content.classList.toggle('collapsed');
}

async function showCommit(hash) {
  document.querySelectorAll('.commit').forEach(c => c.classList.remove('selected'));
  const element = document.getElementById('commit-' + hash);
  if (element) {
    element.classList.add('selected');
    // Update keyboard navigation index to match clicked item
    const clickedIndex = keyboardNav.items.indexOf(element);
    if (clickedIndex !== -1) {
      // Clear previous keyboard selection visual logic to prevent double highlighting
      if (keyboardNav.selectedIndex >= 0 && keyboardNav.items[keyboardNav.selectedIndex]) {
        keyboardNav.items[keyboardNav.selectedIndex].classList.remove('keyboard-selected');
      }
      keyboardNav.selectedIndex = clickedIndex;
    }
  }
  currentSelection = { type: 'commit', hash };
  currentlyDisplayedCommitHash = hash;

  try {
    // Fetch commit details to get the list of files
    const response = await fetch(`${API}/git/commit-details?commitHash=${hash}`);
    const data = await response.json();

    if (data.success) {
      // Get the actual diff for the commit
      const diffResponse = await fetch(`${API}/git/commit-diff?commitHash=${hash}`);
      const diffData = await diffResponse.json();

      // Set panel title
      // Set panel title
      // Swap: Show hash in title instead of date
      document.getElementById('rightPanelTitle').textContent = t('timeline.version_title', { hash: hash.substring(0, 8) });

      // Clear actions initially, will be set by displayCommitDiff if there are changes
      document.getElementById('rightPanelActions').innerHTML = '';

      // Get commit date from allCommits
      const commitObj = allCommits.find(c => c.hash === hash);
      const commitDate = commitObj ? commitObj.date : null;

      if (diffData.success) {
        await displayCommitDiff(data.status, hash, diffData.diff, commitDate);
      } else {
        await displayCommitDiff(data.status, hash, t('diff.no_diff_available'), commitDate);
      }

      // Show the floating button when a diff is being viewed
      showFloatingConfirmRestoreButton();


    }
  } catch (error) {
    console.error('Error:', error);
  }
}

function displayFiles(status, hash) {
  const lines = status.split('\n').filter(line => line.trim());
  const files = lines.slice(1).map(line => {
    const parts = line.split('\t');
    return { status: parts[0], file: parts[1] };
  }).filter(f => f.file);

  // Set panel title and clear actions
  document.getElementById('rightPanelTitle').textContent = t('timeline.files_in_version');
  document.getElementById('rightPanelActions').innerHTML = '';

  if (files.length === 0) {
    document.getElementById('rightPanel').innerHTML = `<div class="empty">${t('timeline.no_files_in_commit')}</div>`;
    return;
  }

  const html = files.map(file => `
        <div class="file">
          <div class="file-icon"></div>
          <div class="file-path">
            <div class="file-name">${file.file}</div>
            <div class="file-path-text">${file.status === 'A' ? t('file_status.added') : file.status === 'D' ? t('file_status.deleted') : t('file_status.modified')}</div>
          </div>
          <div>
            <button class="btn" onclick="viewDiff('${file.file}', '${hash}')">${t('files.view_button')}</button>
            <button class="btn restore" onclick="restoreFile('${file.file}', '${hash}')" title="${t('files.restore_tooltip')}">${t('files.restore_button')}</button>
          </div>
        </div>
      `).join('');

  document.getElementById('rightPanel').innerHTML = html;
}


async function displayCommitDiff(status, hash, diff, commitDate = null) {
  // Parse files from status
  const lines = status.split('\n').filter(line => line.trim());
  let files = lines.slice(1).map(line => {
    const parts = line.split('\t');
    return { status: parts[0], file: parts[1] };
  }).filter(f => f.file);

  // Sort files alphabetically, ignoring leading dots (so .storage sorts as storage)
  files.sort((a, b) => {
    const nameA = a.file.replace(/^\./, '');
    const nameB = b.file.replace(/^\./, '');
    return nameA.localeCompare(nameB, undefined, { sensitivity: 'base' });
  });

  // Tab-specific filter: Timeline shows all, others show only changed files
  const showChangedOnly = currentMode !== 'timeline';

  // Determine if we need to use shifted mode for Timeline
  let compareHash = hash; // Default: compare to the commit being viewed
  let compareDate = commitDate; // Default: date of the commit being viewed
  let isOldestCommit = false;

  if (diffMode === 'shifted' && compareToCurrent) {
    // Find this commit's position in allCommits
    const commitIndex = allCommits.findIndex(c => c.hash === hash);
    isOldestCommit = commitIndex === allCommits.length - 1;

    if (!isOldestCommit && commitIndex !== -1) {
      // Get the next older commit hash
      const compareCommit = allCommits[commitIndex + 1];
      compareHash = compareCommit.hash;
      compareDate = compareCommit.date;
    }
  }

  // For each file, get current content and commit version, then compare
  let allDiffsHtml = '';
  let filesWithChanges = [];
  let filesWithoutChanges = [];

  for (const file of files) {
    try {
      // For oldest commit in shifted mode, don't try to fetch/compare - just show files
      if (diffMode === 'shifted' && isOldestCommit && compareToCurrent) {
        // Get commit version to display the file
        const commitResponse = await fetch(`${API}/git/file-at-commit?filePath=${encodeURIComponent(file.file)}&commitHash=${hash}`);
        const commitData = await commitResponse.json();
        let commitContent = commitData.success ? commitData.content : '';

        // Also get current content for label comparison
        const currentResponse = await fetch(`${API}/file-content?filePath=${encodeURIComponent(file.file)}`);
        const currentData = await currentResponse.json();
        let currentContent = currentData.success ? currentData.content : '';

        // Remove filename if present
        const fileName = file.file;
        if (commitContent.startsWith(fileName)) {
          commitContent = commitContent.substring(commitContent.indexOf('\n') + 1);
        }
        if (currentContent.startsWith(fileName)) {
          currentContent = currentContent.substring(currentContent.indexOf('\n') + 1);
        }

        const commitLines = commitContent.split(/\r\n?|\n/);
        filesWithoutChanges.push({ file, commitLines, commitContent, currentContent });
        continue;
      }

      // Get current file content (only needed if compareToCurrent is ON)
      let currentContent = '';
      if (compareToCurrent) {
        const currentResponse = await fetch(`${API}/file-content?filePath=${encodeURIComponent(file.file)}`);
        const currentData = await currentResponse.json();
        currentContent = currentData.success ? currentData.content : '';
      }

      // Use the new generateDiff function for consistent rendering
      // Swap: Show date in diff label instead of hash
      let rightLabel = compareDate ? formatDateForBanner(compareDate) : `Version ${hash.substring(0, 8)}`;

      // Determine effective comparison hash and label
      let effectiveCompareHash = compareHash;

      // Special handling for added files in shifted mode:
      // If a file is ADDED in this commit, we should NOT compare it to the previous commit (where it didn't exist).
      // Also, we should NOT compare it to the current live version, because if the live version changes later,
      // the "Added" view would show those future changes, which is confusing.
      // Instead, we compare the commit against ITSELF. This results in "No changes found",
      // which our renderer handles by showing the clean file content.
      if (diffMode === 'shifted' && compareToCurrent) {
        if (file.status === 'A') {
          effectiveCompareHash = hash; // Compare to itself
          // For the "Current" side (left), we also want to show the commit version, not live
          // This is a special case where we override the "Current" content below
        } else {
          rightLabel = compareDate ? formatDateForBanner(compareDate) : `Version ${compareHash.substring(0, 8)}`;
        }
      }

      // Get commit version content (use effectiveCompareHash)
      const commitResponse = await fetch(`${API}/git/file-at-commit?filePath=${encodeURIComponent(file.file)}&commitHash=${effectiveCompareHash}`);
      const commitData = await commitResponse.json();
      let commitContent = commitData.success ? commitData.content : '';

      // Workaround: Remove filename from content if present (unexpected behavior from backend)
      const fileName = file.file;
      if (currentContent.startsWith(fileName)) {
        currentContent = currentContent.substring(currentContent.indexOf('\n') + 1);
      }
      if (commitContent.startsWith(fileName)) {
        commitContent = commitContent.substring(commitContent.indexOf('\n') + 1);
      }

      // Special handling for Added files in shifted mode:
      // Compare the file against itself (commit version vs commit version)
      // This makes it behave like the initial commit - shows content but no diff
      // Only subsequent modifications will show as changed diffs
      let leftContent = '';
      let leftLabel = '';

      if (compareToCurrent) {
        // Compare to Current ON: Use current file as left side
        leftContent = currentContent;
        leftLabel = 'Current Version';

        // In shifted mode with Added files, we show the commit version on both sides
        if (diffMode === 'shifted' && file.status === 'A') {
          leftContent = commitContent;
          leftLabel = `Version ${hash.substring(0, 8)}`;
        }
      } else {
        // Compare to Current OFF: Use parent commit as left side (GitHub-style)
        if (file.status === 'A') {
          // For newly added files, left side is empty
          leftContent = '';
          leftLabel = 'Before';
        } else {
          // Get parent commit's version
          const parentResponse = await fetch(`${API}/git/file-at-commit?filePath=${encodeURIComponent(file.file)}&commitHash=${effectiveCompareHash}^`);
          const parentData = await parentResponse.json();
          leftContent = parentData.success ? parentData.content : '';

          // Remove filename if present
          if (leftContent.startsWith(file.file)) {
            leftContent = leftContent.substring(leftContent.indexOf('\n') + 1);
          }

          leftLabel = 'Before';
        }
        // Update rightLabel to show the commit date
        rightLabel = commitDate ? formatDateForBanner(commitDate) : `Version ${effectiveCompareHash.substring(0, 8)}`;
      }

      const currentLines = leftContent.split(/\r\n?|\n/);
      const commitLines = commitContent.split(/\r\n?|\n/);

      const diffHtml = generateDiff(leftContent, commitContent, {
        leftLabel: leftLabel,
        rightLabel: rightLabel,
        bannerText: file.status === 'A' ? `${file.file} (Added)` : file.file,
        returnNullIfNoChanges: true,
        filePath: file.file
      });

      // If there's a diff, add it to the changes list
      // Note: generateDiff returns null if returnNullIfNoChanges is true and there are no changes
      if (diffHtml) {
        filesWithChanges.push({ file, diffHtml });
      } else {
        // No diff, but we'll show the full file content
        // Store both commit content and current content for label comparison
        filesWithoutChanges.push({ file, commitLines, commitContent, currentContent });
      }
    } catch (error) {
      console.error(`Error comparing file ${file.file}:`, error);
      showNotification(`Error comparing file ${file.file}: ${error.message}`, 'error');
    }
  }

  // Determine if we need dropdowns (more than one file total)
  const totalFiles = filesWithChanges.length + filesWithoutChanges.length;
  const needsDropdown = totalFiles > 1;
  const shouldCollapse = totalFiles > 3;

  // Process files with changes
  for (const item of filesWithChanges) {
    if (needsDropdown) {
      const expandedClass = shouldCollapse ? '' : 'expanded';
      const displayStyle = shouldCollapse ? 'display: none' : 'display: block';

      allDiffsHtml += `
        <div class="file-diff-section">
          <div class="file-diff-header ${expandedClass}" onclick="toggleFileDiff(this)">
            <span class="file-name">${item.file.file} (${item.file.status === 'A' ? 'Added' : item.file.status === 'D' ? 'Deleted' : 'Modified'})</span>
          </div>
          <div class="file-diff-content" style="${displayStyle}">
            <div class="diff-view-container">
              ${item.diffHtml}
            </div>
          </div>
        </div>`;
    } else {
      // Single file - no dropdown needed
      allDiffsHtml += `
        <div class="diff-view-container">
          ${item.diffHtml}
        </div>`;
    }
  }

  // Process files without changes (render them with dropdowns too if needed)
  for (const item of filesWithoutChanges) {
    const trimmedLines = trimEmptyLines(item.commitLines);
    const fullFileHtml = generateFullFileHTML(trimmedLines);
    // Determine label: if commit content matches current, it's still current
    const label = (item.commitContent === item.currentContent) ? 'Current Version' : `Version ${hash.substring(0, 8)}`;

    if (needsDropdown) {
      const expandedClass = shouldCollapse ? '' : 'expanded';
      const displayStyle = shouldCollapse ? 'display: none' : 'display: block';

      allDiffsHtml += `
        <div class="file-diff-section">
          <div class="file-diff-header ${expandedClass}" onclick="toggleFileDiff(this)">
            <span class="file-name">${item.file.file} (${item.file.status === 'A' ? 'Added' : item.file.status === 'D' ? 'Deleted' : 'Modified'})</span>
          </div>
          <div class="file-diff-content" style="${displayStyle}">
            <div class="diff-view-container">
              <div class="segmented-control" style="cursor: default; grid-template-columns: 1fr;">
                <div class="segmented-control-slider" style="width: calc(100% - 8px);"></div>
                <label style="cursor: default; color: var(--text-primary);">${label}</label>
              </div>
              <div class="diff-viewer-shell ${currentDiffStyle}">
                <div class="diff-viewer-unified">
                  ${fullFileHtml}
                </div>
              </div>
            </div>
          </div>
        </div>`;
    } else {
      // Single file - no dropdown needed
      allDiffsHtml += `
        <div class="diff-view-container">
          <div class="segmented-control" style="cursor: default; grid-template-columns: 1fr;">
            <div class="segmented-control-slider" style="width: calc(100% - 8px);"></div>
            <label style="cursor: default; color: var(--text-primary);">${label}</label>
          </div>
          <div class="diff-viewer-shell ${currentDiffStyle}">
            <div class="diff-viewer-unified">
              ${fullFileHtml}
            </div>
          </div>
        </div>`;
    }
  }

  // Create header with file list
  const changedFilesSummary = filesWithChanges.map(item => {
    const action = item.file.status === 'A' ? 'Added' : item.file.status === 'D' ? 'Deleted' : 'Modified';
    return `${item.file.file} (${action})`;
  });

  const unchangedFilesSummary = filesWithoutChanges.map(item => {
    const action = item.file.status === 'A' ? 'Added' : item.file.status === 'D' ? 'Deleted' : 'Modified';
    return `${item.file.file} (${action})`;
  });

  const fileSummary = [...changedFilesSummary, ...unchangedFilesSummary].join('<br>') || (showChangedOnly ? t('timeline.no_files_with_changes') : t('timeline.all_files'));

  // Show restore button if there are changes
  if (filesWithChanges.length > 0) {
    document.getElementById('rightPanelActions').innerHTML = `
      <button 
        id="restore-commit-btn"
        class="btn restore" 
        onmousedown="handleRestoreButtonDown('${hash}', '${compareHash}')"
        onmouseup="handleRestoreButtonUp('${hash}', '${compareHash}')"
        onmouseleave="handleRestoreButtonCancel()"
        ontouchstart="handleRestoreButtonDown('${hash}', '${compareHash}')"
        ontouchend="handleRestoreButtonUp('${hash}', '${compareHash}')"
        ontouchcancel="handleRestoreButtonCancel()">
        <span id="restore-btn-text">${t('timeline.restore_commit')}</span>
      </button>
    `;
  } else {
    document.getElementById('rightPanelActions').innerHTML = '';
  }

  // Build the HTML for the right panel
  const html = `
        <div class="commit-viewer">
          <div class="commit-viewer-header">
            <div class="commit-viewer-info">
              <div class="commit-files-summary">${fileSummary}</div>
            </div>
          </div>
          <div class="unified-diff">
            <div class="diff-content">
              ${allDiffsHtml || `<div class="empty">${t('timeline.no_files')}</div>`}
            </div>
          </div>
        </div>
      `;

  document.getElementById('rightPanel').innerHTML = html;
}


let currentFileHistory = []; // Store file history for time slider
let currentFileHistoryIndex = 0; // Current position in history
let isScanningHistory = false; // Flag to track if we are currently scanning history

async function loadScripts() {
  const leftPanel = document.getElementById('leftPanel');
  leftPanel.innerHTML = `<div class="empty" data-i18n="app.loading">Loading...</div>`;

  try {
    const response = await fetch(`${API}/scripts`);
    const data = await response.json();

    if (data.success) {
      allScripts = data.scripts;
      const sortedScripts = sortItems(data.scripts, sortState.scripts);
      displayScripts(sortedScripts);
    } else {
      leftPanel.innerHTML = `<div class="error" data-i18n="scripts.error_loading">Error loading scripts: ${data.error}</div>`;
    }
  } catch (error) {
    leftPanel.innerHTML = `<div class="error" data-i18n="scripts.error_loading">Error loading scripts: ${error.message}</div>`;
  }
}

async function loadAutomations() {
  const leftPanel = document.getElementById('leftPanel');
  leftPanel.innerHTML = `<div class="empty" data-i18n="app.loading">Loading...</div>`;

  try {
    const response = await fetch(`${API}/automations`);
    const data = await response.json();

    if (data.success) {
      allAutomations = data.automations;
      const sortedAutomations = sortItems(data.automations, sortState.automations);
      displayAutomations(sortedAutomations);
    } else {
      leftPanel.innerHTML = `<div class="error" data-i18n="automations.error_loading">Error loading automations: ${data.error}</div>`;
    }
  } catch (error) {
    leftPanel.innerHTML = `<div class="error" data-i18n="automations.error_loading">Error loading automations: ${error.message}</div>`;
  }
}

async function loadFiles() {
  const leftPanel = document.getElementById('leftPanel');
  leftPanel.innerHTML = `<div class="empty" data-i18n="app.loading">Loading...</div>`;

  try {
    const response = await fetch(`${API}/files`);
    const data = await response.json();

    if (data.success) {
      allFiles = data.files;
      currentFilePath = ''; // Reset to root

      // Sort files
      const sortedFiles = sortItems(data.files.map(f => typeof f === 'string' ? { path: f, name: f } : { ...f, name: f.path }), sortState.files);
      displayFileList(sortedFiles);
    } else {
      leftPanel.innerHTML = `<div class="error" data-i18n="files.error_loading">Error loading files: ${data.error}</div>`;
    }
  } catch (error) {
    leftPanel.innerHTML = `<div class="error" data-i18n="files.error_loading">Error loading files: ${error.message}</div>`;
  }
}

function createFolderBreadcrumb(filePath) {
  const parts = filePath.split('/');
  let html = `<span class="breadcrumb-item clickable" onclick="navigateToPath('')">config</span>`;

  let path = '';
  for (let i = 0; i < parts.length; i++) {
    path += (i > 0 ? '/' : '') + parts[i];
    html += `<span class="breadcrumb-separator">/</span>`;
    if (i === parts.length - 1) {
      html += `<span class="breadcrumb-current">${parts[i]}</span>`;
    } else {
      html += `<span class="breadcrumb-item clickable" onclick="navigateToPath('${path}')">${parts[i]}</span>`;
    }
  }
  return html;
}

function displayFileList(files) {
  const items = [];
  const currentFolder = currentFilePath ? currentFilePath + '/' : '';

  const folderSet = new Set();

  files.forEach(fileObj => {
    // Handle both string paths (legacy/search) and object paths (new format)
    const filePath = typeof fileObj === 'string' ? fileObj : fileObj.path;

    if (filePath.startsWith(currentFolder)) {
      const relativePath = filePath.substring(currentFolder.length);
      const parts = relativePath.split('/');
      if (parts.length > 1) {
        // It's in a subfolder
        const folderName = parts[0];
        if (!folderSet.has(folderName)) {
          folderSet.add(folderName);
          items.push({
            name: folderName,
            type: 'folder',
            path: currentFolder + folderName
          });
        }
      } else {
        // It's a file in the current folder
        items.push({
          name: relativePath,
          type: 'file',
          path: filePath
        });
      }
    }
  });

  // Only sort if we are in a folder view where we mixed folders and files
  // Otherwise respect the order passed in (which is already sorted)
  // But we do want folders first usually?
  // For now, let's trust the passed order but maybe we should separate folders?
  // The user wants "Recently Modified", so if a file in a folder is modified, the folder should probably be up top?
  // Or just list them.
  // The original code sorted by name.
  // If we want to support "Recently Modified", we should probably NOT re-sort here.

  // However, we need to make sure folders don't get mixed weirdly if the input is sorted by date.
  // If sorted by date, a file might be newer than a folder (which doesn't really have a date here).
  // Let's just rely on the input order for now.


  let html = '';

  if (currentFilePath) {
    const breadcrumb = createFolderBreadcrumb(currentFilePath);
    html += `<div class="breadcrumb">${breadcrumb}</div>`;
  }

  items.forEach(item => {
    if (item.type === 'folder') {
      html += `
            <div class="file" onclick="navigateToPath('${item.path}')">
              <div class="file-icon"></div>
              <div class="file-path">
                <div class="file-name">${item.name}</div>
                <div class="file-path-text">${t('files.folder_label')}</div>
              </div>
              <div class="folder-chevron">›</div>
            </div>
          `;
    } else {
      const fileId = 'file-' + item.path.replace(/\//g, '-').replace(/\./g, '-');
      html += `
            <div class="file" onclick="showFileHistory('${item.path}')" id="${fileId}">
              <div class="file-icon"></div>
              <div class="file-path">
                <div class="file-name">${item.name}</div>
                <div class="file-path-text">${currentFilePath || 'config'}</div>
              </div>
            </div>
          `;
    }
  });

  if (!html && !currentFilePath) {
    html = `<div class="empty">${t('files.empty_state')}</div>`;
  } else if (!html && currentFilePath) {
    html += `<div class="empty">${t('files.empty_state')}</div>`;
  }


  document.getElementById('leftPanel').innerHTML = html;
  document.getElementById('rightPanel').innerHTML = `<div class="empty">${t('files.select_file')}</div>`;
  document.getElementById('rightPanelActions').innerHTML = '';

  const fileItems = Array.from(document.querySelectorAll('.file'));
  updateKeyboardNavState('files', fileItems);

  hideFloatingConfirmRestoreButton();
}

async function showFileHistory(filePath) {
  document.querySelectorAll('.file').forEach(f => f.classList.remove('selected'));
  const fileId = 'file-' + filePath.replace(/\//g, '-').replace(/\./g, '-');
  const element = document.getElementById(fileId);
  if (element) {
    element.classList.add('selected');
    // Update keyboard navigation index to match clicked item
    const clickedIndex = keyboardNav.items.indexOf(element);
    if (clickedIndex !== -1) {
      // Clear previous keyboard selection visual logic to prevent double highlighting
      if (keyboardNav.selectedIndex >= 0 && keyboardNav.items[keyboardNav.selectedIndex]) {
        keyboardNav.items[keyboardNav.selectedIndex].classList.remove('keyboard-selected');
      }
      keyboardNav.selectedIndex = clickedIndex;
    }
  }

  currentSelection = { type: 'file', file: filePath };

  try {
    // First get the current file content
    const currentContentResponse = await fetch(`${API}/file-content?filePath=${encodeURIComponent(filePath)}`);
    const currentContentData = await currentContentResponse.json();
    const currentContent = currentContentData.success ? currentContentData.content : '';

    // Get the file history
    const response = await fetch(`${API}/git/file-history?filePath=${encodeURIComponent(filePath)}`);
    const data = await response.json();

    if (data.success) {
      // Initialize with empty history
      currentFileHistory = [];
      currentFileHistoryIndex = 0;
      let lastKeptContent = null;
      let isFirstVersion = true;
      isScanningHistory = true;

      // Process versions progressively
      for (let i = 0; i < data.log.all.length; i++) {
        const commit = data.log.all[i];

        try {
          const commitResponse = await fetch(`${API}/git/file-at-commit?filePath=${encodeURIComponent(filePath)}&commitHash=${commit.hash}`);
          const commitData = await commitResponse.json();
          const commitContent = commitData.success ? commitData.content : '';

          // Check if there are actual visible differences from the CURRENT version
          const diffVsCurrent = generateDiff(commitContent, currentContent, {
            returnNullIfNoChanges: true,
            filePath: filePath
          });

          // Skip if identical to live
          if (diffVsCurrent === null) continue;

          // Check against the last kept version to avoid consecutive duplicates
          if (lastKeptContent !== null) {
            const diffVsLast = generateDiff(commitContent, lastKeptContent, {
              returnNullIfNoChanges: true,
              filePath: filePath
            });
            if (diffVsLast === null) continue;
          }

          // Add this version to history
          commit.content = commitContent;
          currentFileHistory.push(commit);
          lastKeptContent = commitContent;

          // Display immediately when we find the first valid version
          if (isFirstVersion) {
            isFirstVersion = false;
            displayFileHistory(filePath);
          } else {
            // Update the navigation controls for subsequent versions
            updateFileHistoryNavigation(filePath);
          }
        } catch (error) {
          console.error(`Error checking commit ${commit.hash}:`, error);
        }
      }


      // Scanning complete
      isScanningHistory = false;
      if (currentFileHistory.length > 0) {
        // Check if the oldest commit is when the file was added
        // by seeing if the file exists in the parent commit
        const oldestCommit = currentFileHistory[currentFileHistory.length - 1];
        try {
          // Try to fetch the file from the parent commit (commitHash^)
          const parentResponse = await fetch(`${API}/git/file-at-commit?filePath=${encodeURIComponent(filePath)}&commitHash=${oldestCommit.hash}^`);
          const parentData = await parentResponse.json();

          // If file doesn't exist in parent, this commit added the file
          if (!parentData.success) {
            oldestCommit.status = 'A';
          }
        } catch (error) {
          // If there's an error (e.g., no parent commit), assume it was added
          oldestCommit.status = 'A';
        }

        updateFileHistoryNavigation(filePath);
      }

      // If no versions with changes were found, show current content as a no-change diff
      if (currentFileHistory.length === 0) {
        // Use the hash from the most recent commit in the full history
        const mostRecentHash = data.log.all.length > 0 ? data.log.all[0].hash : '';
        const mostRecentCommitDate = data.log.all.length > 0 ? data.log.all[0].date : new Date();

        document.getElementById('rightPanelTitle').textContent = filePath.split('/').pop();
        document.getElementById('itemsSubtitle').textContent = '';
        document.getElementById('rightPanelActions').innerHTML = '';

        // Create a diff view container with header matching the change view
        document.getElementById('rightPanel').innerHTML = `
          <div class="file-history-viewer">
            <div class="file-history-header">
              <div class="file-history-info">
                <div class="history-position">1 of 1 — ${formatDateForBanner(mostRecentCommitDate)} (${mostRecentHash.substring(0, 8)})</div>
              </div>
              <div class="file-history-actions">
                <button class="btn" disabled style="border: 1px solid var(--border-subtle); min-width: 36px; padding: 8px 12px;">◀</button>
                <button class="btn" disabled style="border: 1px solid var(--border-subtle); min-width: 36px; padding: 8px 12px;">▶</button>
              </div>
            </div>
            <div id="fileDiffContent"></div>
          </div>
        `;

        // Render the current content as a no-change diff
        renderDiff(currentContent, currentContent, document.getElementById('fileDiffContent'), {
          leftLabel: 'Current Version',
          rightLabel: 'Current Version',
          filePath: filePath
        });
      }

    } else {
      document.getElementById('rightPanel').innerHTML = `<div class="empty">${t('files.failed_to_load_history')}</div>`;
    }
  } catch (error) {
    console.error('Error:', error);
    document.getElementById('rightPanel').innerHTML = `<div class="empty">${t('files.error_loading_history', { error: error.message })}</div>`;
  }
}

// Helper function to update navigation controls without reloading the diff
function updateFileHistoryNavigation(filePath) {
  const historyPosition = document.getElementById('historyPosition');
  const prevBtn = document.getElementById('prevBtn');
  const nextBtn = document.getElementById('nextBtn');

  if (historyPosition && prevBtn && nextBtn) {
    const currentCommit = currentFileHistory[currentFileHistoryIndex];
    if (isScanningHistory) {
      historyPosition.textContent = `${currentFileHistoryIndex + 1} — ${formatDateForBanner(currentCommit.date)} (${currentCommit.hash.substring(0, 8)})`;
    } else {
      historyPosition.textContent = `${currentFileHistoryIndex + 1} of ${currentFileHistory.length} — ${formatDateForBanner(currentCommit.date)} (${currentCommit.hash.substring(0, 8)})`;
    }

    // Update button states
    prevBtn.disabled = currentFileHistoryIndex === 0;
    nextBtn.disabled = currentFileHistoryIndex === currentFileHistory.length - 1;
  }
}

let allAutomations = [];
let allScripts = [];
let currentAutomationHistory = []; // Store automation history for time slider
let currentAutomationHistoryIndex = 0; // Current position in history
let currentScriptHistory = []; // Store script history for time slider
let currentScriptHistoryIndex = 0; // Current position in history



function displayAutomations(automations) {
  let html = '';

  if (automations.length === 0) {
    html = `<div class="empty">${t('automations.empty_state')}</div>`;
  } else {
    automations.forEach(auto => {
      const autoId = 'auto-' + auto.id.replace(/[:/]/g, '-');
      html += `
            <div class="file" onclick="showAutomationHistory('${auto.id}')" id="${autoId}">
              <div class="file-icon"></div>
              <div class="file-path">
                <div class="file-name">${auto.name}</div>
                <div class="file-path-text">${auto.file}</div>
              </div>
            </div>
          `;
    });
  }

  document.getElementById('leftPanel').innerHTML = html;
  document.getElementById('rightPanel').innerHTML = `<div class="empty">${t('automations.select_automation')}</div>`;
  document.getElementById('rightPanelActions').innerHTML = '';

  // Update keyboard navigation
  const automationItems = Array.from(document.querySelectorAll('.file'));
  updateKeyboardNavState('automations', automationItems);

  // Hide the floating button when not viewing a diff
  hideFloatingConfirmRestoreButton();
}

async function showAutomationHistory(automationId) {
  document.querySelectorAll('.file').forEach(f => f.classList.remove('selected'));
  const autoId = 'auto-' + automationId.replace(/[:/]/g, '-');
  const element = document.getElementById(autoId);
  if (element) {
    element.classList.add('selected');
    // Update keyboard navigation index to match clicked item
    const clickedIndex = keyboardNav.items.indexOf(element);
    if (clickedIndex !== -1) {
      // Clear previous keyboard selection visual logic to prevent double highlighting
      if (keyboardNav.selectedIndex >= 0 && keyboardNav.items[keyboardNav.selectedIndex]) {
        keyboardNav.items[keyboardNav.selectedIndex].classList.remove('keyboard-selected');
      }
      keyboardNav.selectedIndex = clickedIndex;
    }
  }

  currentSelection = { type: 'automation', id: automationId };

  try {
    const response = await fetch(`${API}/automation/${encodeURIComponent(automationId)}/history`);
    const data = await response.json();

    if (data.success && data.history.length > 0) {
      // Get the current automation content for comparison
      const auto = allAutomations.find(a => a.id === automationId);
      const currentContent = dumpYaml(auto.content);

      // Initialize with empty history
      currentAutomationHistory = [];
      currentAutomationHistoryIndex = 0;
      let lastKeptContent = null;
      let isFirstVersion = true;
      isScanningHistory = true;

      // Process versions progressively
      for (let i = 0; i < data.history.length; i++) {
        const commit = data.history[i];
        const commitContent = dumpYaml(commit.automation);

        // Check if there are visible differences compared to the CURRENT version
        const diffVsCurrent = generateDiff(commitContent, currentContent, {
          returnNullIfNoChanges: true,
          filePath: auto.file
        });

        // Skip if identical to live
        if (diffVsCurrent === null) continue;

        // Check against the last kept version to avoid consecutive duplicates
        if (lastKeptContent !== null) {
          const diffVsLast = generateDiff(commitContent, lastKeptContent, {
            returnNullIfNoChanges: true,
            filePath: auto.file
          });
          if (diffVsLast === null) continue;
        }

        // Add this version to history
        currentAutomationHistory.push({
          ...commit,
          yamlContent: commitContent
        });
        lastKeptContent = commitContent;

        // Display immediately when we find the first valid version
        if (isFirstVersion) {
          isFirstVersion = false;
          // Set the panel title
          document.getElementById('rightPanelTitle').textContent = auto ? auto.name : 'Automation';
          document.getElementById('rightPanelActions').innerHTML = `<button class="btn restore" onclick="restoreAutomationVersion('${automationId}')" title="${t('diff.tooltip_overwrite_automation')}">${t('timeline.restore_commit')}</button>`;
          displayAutomationHistory();
        } else {
          // Update the navigation controls for subsequent versions
          updateAutomationHistoryNavigation();
        }
      }

      // Scanning complete
      isScanningHistory = false;
      if (currentAutomationHistory.length > 0) {
        updateAutomationHistoryNavigation();
      }

      // If no versions with changes were found, show current content as a no-change diff
      if (currentAutomationHistory.length === 0) {
        // Use the hash from the most recent commit in the full history
        const mostRecentHash = data.history.length > 0 ? data.history[0].hash : '';
        const mostRecentCommitDate = data.history.length > 0 ? data.history[0].date : new Date();

        document.getElementById('rightPanelTitle').textContent = auto ? auto.name : 'Automation';
        document.getElementById('itemsSubtitle').textContent = '';
        document.getElementById('rightPanelActions').innerHTML = '';

        // Create a diff view container with header matching the change view
        document.getElementById('rightPanel').innerHTML = `
          <div class="file-history-viewer">
            <div class="file-history-header">
              <div class="file-history-info">
                <div class="history-position">1 of 1 — ${formatDateForBanner(mostRecentCommitDate)} (${mostRecentHash.substring(0, 8)})</div>
              </div>
              <div class="file-history-actions">
                <button class="btn" disabled style="border: 1px solid var(--border-subtle); min-width: 36px; padding: 8px 12px;">◀</button>
                <button class="btn" disabled style="border: 1px solid var(--border-subtle); min-width: 36px; padding: 8px 12px;">▶</button>
              </div>
            </div>
            <div id="automationDiffContent"></div>
          </div>
        `;

        // Render the current content as a no-change diff
        renderDiff(currentContent, currentContent, document.getElementById('automationDiffContent'), {
          leftLabel: 'Current Version',
          rightLabel: 'Current Version',
          filePath: auto.file
        });
      }
    } else {
      let debugHtml = '';
      if (data.debugMessages && data.debugMessages.length > 0) {
        debugHtml = `
              <div class="debug-info" style="margin-top: 20px; padding: 10px; background-color: #333; border-radius: 5px;">
                <h4>Debug Information:</h4>
                <ul style="list-style-type: none; padding: 0; font-size: 0.8em;">
                  ${data.debugMessages.map(msg => `<li>${escapeHtml(msg)}</li>`).join('')}
                </ul>
              </div>
            `;
      }
      document.getElementById('rightPanel').innerHTML = `
            <div class="empty">${t('history.no_changes')}</div>
            ${debugHtml}
          `;


    }
  } catch (error) {
    console.error('Error loading automation history:', error);
    let debugHtml = '';
    // If the error is from the fetch itself, data.debugMessages might not exist
    if (error.debugMessages && error.debugMessages.length > 0) {
      debugHtml = `
            <div class="debug-info" style="margin-top: 20px; padding: 10px; background-color: #333; border-radius: 5px;">
              <h4>Debug Information:</h4>
              <ul style="list-style-type: none; padding: 0; font-size: 0.8em;">
                ${error.debugMessages.map(msg => `<li>${escapeHtml(msg)}</li>`).join('')}
              </ul>
            </div>
          `;
    }
    document.getElementById('rightPanel').innerHTML = `
          <div class="empty">${t('history.error_loading', { error: error.message })}</div>
          ${debugHtml}
        `;


  }
}

function displayAutomationHistory() {
  if (currentAutomationHistory.length === 0) {
    document.getElementById('rightPanel').innerHTML = `<div class="empty">${t('history.no_changes')}</div>`;
    return;
  }

  // Build the HTML for the right panel with navigation
  const html = `
        <div class="file-history-viewer">
          <div class="file-history-header">
            <div class="file-history-info">
              <div class="history-position" id="automationHistoryPosition">1 of ${currentAutomationHistory.length}</div>
            </div>
            <div class="file-history-actions">
              <button class="btn" id="autoPrevBtn" onclick="navigateAutomationHistory(-1)" ${currentAutomationHistoryIndex === 0 ? 'disabled' : ''} style="border: 1px solid var(--border-subtle); min-width: 36px; padding: 8px 12px;">◀</button>
              <button class="btn" id="autoNextBtn" onclick="navigateAutomationHistory(1)" ${currentAutomationHistoryIndex === currentAutomationHistory.length - 1 ? 'disabled' : ''} style="border: 1px solid var(--border-subtle); min-width: 36px; padding: 8px 12px;">▶</button>
            </div>
          </div>
          <div class="diff-view-container" id="automationDiffContent"></div>
        </div>
      `;

  document.getElementById('rightPanel').innerHTML = html;

  // Show the floating button when viewing automation history
  showFloatingConfirmRestoreButton();

  // Load the initial version
  loadAutomationHistoryDiff();
}

async function loadAutomationHistoryDiff() {
  const currentCommit = currentAutomationHistory[currentAutomationHistoryIndex];

  // Update position indicator
  // Update position indicator
  if (isScanningHistory) {
    document.getElementById('automationHistoryPosition').textContent =
      `${currentAutomationHistoryIndex + 1} — ${formatDateForBanner(currentCommit.date)} (${currentCommit.hash.substring(0, 8)})`;
  } else {
    document.getElementById('automationHistoryPosition').textContent =
      `${currentAutomationHistoryIndex + 1} of ${currentAutomationHistory.length} — ${formatDateForBanner(currentCommit.date)} (${currentCommit.hash.substring(0, 8)})`;
  }

  // Update button states
  document.getElementById('autoPrevBtn').disabled = currentAutomationHistoryIndex === 0;
  document.getElementById('autoNextBtn').disabled = currentAutomationHistoryIndex === currentAutomationHistory.length - 1;

  const auto = allAutomations.find(a => a.id === currentSelection.id);
  if (!auto) return;

  const currentContent = dumpYaml(auto.content);
  let leftContent = '';
  let rightContent = '';
  let leftLabel = '';
  let rightLabel = '';

  if (compareToCurrent) {
    // Compare to Current ON: Compare current version (left) vs commit version (right)
    // Note: renderDiff swaps args, so we pass (right, left)
    const commitContent = currentCommit.yamlContent || dumpYaml(currentCommit.automation);

    leftContent = currentContent;
    rightContent = commitContent;
    leftLabel = 'Current Version';
    rightLabel = formatDateForBanner(currentCommit.date);
  } else {
    // Compare to Current OFF: Compare parent (left) vs commit (right)
    const commitContent = currentCommit.yamlContent || dumpYaml(currentCommit.automation);

    // Get parent content from the next item in history (since history is sorted newest to oldest)
    // If this is the last item, treat it as Added (empty parent)
    let parentContent = '';
    const parentIndex = currentAutomationHistoryIndex + 1;
    if (parentIndex < currentAutomationHistory.length) {
      const parentCommit = currentAutomationHistory[parentIndex];
      parentContent = parentCommit.yamlContent || dumpYaml(parentCommit.automation);
    }

    leftContent = parentContent;
    rightContent = commitContent;
    leftLabel = 'Before';
    rightLabel = formatDateForBanner(currentCommit.date);
  }

  const startLine = (auto && auto.line) ? (auto.line - 1) : 0;

  // renderDiff expects (commitContent, currentContent) and calls generateDiff(currentContent, commitContent)
  // i.e. generateDiff(Left, Right)
  // So we pass (Right, Left) to renderDiff
  const diffHtml = renderDiff(rightContent, leftContent, document.getElementById('automationDiffContent'), {
    leftLabel: leftLabel,
    rightLabel: rightLabel,
    startLineOffset: startLine,
    filePath: 'automations.yaml'
  });
}

function navigateAutomationHistory(direction) {
  const newIndex = currentAutomationHistoryIndex + direction;
  if (newIndex >= 0 && newIndex < currentAutomationHistory.length) {
    currentAutomationHistoryIndex = newIndex;
    loadAutomationHistoryDiff();
  }
}

// Helper function to update navigation controls without reloading the diff
function updateAutomationHistoryNavigation() {
  const historyPosition = document.getElementById('automationHistoryPosition');
  const prevBtn = document.getElementById('autoPrevBtn');
  const nextBtn = document.getElementById('autoNextBtn');

  if (historyPosition && prevBtn && nextBtn) {
    const currentCommit = currentAutomationHistory[currentAutomationHistoryIndex];
    if (isScanningHistory) {
      historyPosition.textContent = `${currentAutomationHistoryIndex + 1} — ${formatDateForBanner(currentCommit.date)} (${currentCommit.hash.substring(0, 8)})`;
    } else {
      historyPosition.textContent = `${currentAutomationHistoryIndex + 1} of ${currentAutomationHistory.length} — ${formatDateForBanner(currentCommit.date)} (${currentCommit.hash.substring(0, 8)})`;
    }

    // Update button states
    prevBtn.disabled = currentAutomationHistoryIndex === 0;
    nextBtn.disabled = currentAutomationHistoryIndex === currentAutomationHistory.length - 1;
  }
}


function displayScripts(scripts) {
  let html = '';

  if (scripts.length === 0) {
    html = `<div class="empty">${t('scripts.empty_state')}</div>`;
  } else {
    scripts.forEach(script => {
      const scriptId = 'script-' + script.id.replace(/[:/]/g, '-');
      html += `
            <div class="file" onclick="showScriptHistory('${script.id}')" id="${scriptId}">
              <div class="file-icon"></div>
              <div class="file-path">
                <div class="file-name">${script.name}</div>
                <div class="file-path-text">${script.file}</div>
              </div>
            </div>
          `;
    });
  }

  document.getElementById('leftPanel').innerHTML = html;
  document.getElementById('rightPanel').innerHTML = `<div class="empty">${t('scripts.select_script')}</div>`;
  document.getElementById('rightPanelActions').innerHTML = '';

  // Update keyboard navigation
  const scriptItems = Array.from(document.querySelectorAll('.file'));
  updateKeyboardNavState('scripts', scriptItems);

  // Hide the floating button when not viewing a diff
  hideFloatingConfirmRestoreButton();
}

async function showScriptHistory(scriptId) {
  document.querySelectorAll('.file').forEach(f => f.classList.remove('selected'));
  const scriptElId = 'script-' + scriptId.replace(/[:/]/g, '-');
  const element = document.getElementById(scriptElId);
  if (element) {
    element.classList.add('selected');
    // Update keyboard navigation index to match clicked item
    const clickedIndex = keyboardNav.items.indexOf(element);
    if (clickedIndex !== -1) {
      // Clear previous keyboard selection visual logic to prevent double highlighting
      if (keyboardNav.selectedIndex >= 0 && keyboardNav.items[keyboardNav.selectedIndex]) {
        keyboardNav.items[keyboardNav.selectedIndex].classList.remove('keyboard-selected');
      }
      keyboardNav.selectedIndex = clickedIndex;
    }
  }

  currentSelection = { type: 'script', id: scriptId };

  try {
    const response = await fetch(`${API}/script/${encodeURIComponent(scriptId)}/history`);
    const data = await response.json();

    if (data.success && data.history.length > 0) {
      // Get the current script content for comparison
      const script = allScripts.find(s => s.id === scriptId);
      const currentContent = dumpYaml(script.content);

      // Initialize with empty history
      currentScriptHistory = [];
      currentScriptHistoryIndex = 0;
      let lastKeptContent = null;
      let isFirstVersion = true;
      isScanningHistory = true;

      // Process versions progressively
      for (let i = 0; i < data.history.length; i++) {
        const commit = data.history[i];
        const commitContent = dumpYaml(commit.script);

        // Check if there are visible differences compared to the CURRENT version
        const diffVsCurrent = generateDiff(commitContent, currentContent, {
          returnNullIfNoChanges: true,
          filePath: script.file
        });

        // Skip if identical to live
        if (diffVsCurrent === null) continue;

        // Check against the last kept version to avoid consecutive duplicates
        if (lastKeptContent !== null) {
          const diffVsLast = generateDiff(commitContent, lastKeptContent, {
            returnNullIfNoChanges: true,
            filePath: script.file
          });
          if (diffVsLast === null) continue;
        }

        // Add this version to history
        currentScriptHistory.push({
          ...commit,
          yamlContent: commitContent
        });
        lastKeptContent = commitContent;

        // Display immediately when we find the first valid version
        if (isFirstVersion) {
          isFirstVersion = false;
          // Set the panel title
          document.getElementById('rightPanelTitle').textContent = script ? script.name : 'Script';
          document.getElementById('rightPanelActions').innerHTML = `<button class="btn restore" onclick="restoreScriptVersion('${scriptId}')" title="${t('diff.tooltip_overwrite_script')}">${t('timeline.restore_commit')}</button>`;
          displayScriptHistory();
        } else {
          // Update the navigation controls for subsequent versions
          updateScriptHistoryNavigation();
        }
      }

      // Scanning complete
      isScanningHistory = false;
      if (currentScriptHistory.length > 0) {
        updateScriptHistoryNavigation();
      }

      // If no versions with changes were found, show current content as a no-change diff
      if (currentScriptHistory.length === 0) {
        // Use the hash from the most recent commit in the full history
        const mostRecentHash = data.history.length > 0 ? data.history[0].hash : '';
        const mostRecentCommitDate = data.history.length > 0 ? data.history[0].date : new Date();

        document.getElementById('rightPanelTitle').textContent = script ? script.name : 'Script';
        document.getElementById('itemsSubtitle').textContent = '';
        document.getElementById('rightPanelActions').innerHTML = '';

        // Create a diff view container with header matching the change view
        document.getElementById('rightPanel').innerHTML = `
          <div class="file-history-viewer">
            <div class="file-history-header">
              <div class="file-history-info">
                <div class="history-position">1 of 1 — ${formatDateForBanner(mostRecentCommitDate)} (${mostRecentHash.substring(0, 8)})</div>
              </div>
              <div class="file-history-actions">
                <button class="btn" disabled style="border: 1px solid var(--border-subtle); min-width: 36px; padding: 8px 12px;">◀</button>
                <button class="btn" disabled style="border: 1px solid var(--border-subtle); min-width: 36px; padding: 8px 12px;">▶</button>
              </div>
            </div>
            <div id="scriptDiffContent"></div>
          </div>
        `;

        // Render the current content as a no-change diff
        renderDiff(currentContent, currentContent, document.getElementById('scriptDiffContent'), {
          leftLabel: 'Current Version',
          rightLabel: 'Current Version',
          filePath: script.file
        });
      }
    } else {
      let debugHtml = '';
      if (data.debugMessages && data.debugMessages.length > 0) {
        debugHtml = `
              <div class="debug-info" style="margin-top: 20px; padding: 10px; background-color: #333; border-radius: 5px;">
                <h4>Debug Information:</h4>
                <ul style="list-style-type: none; padding: 0; font-size: 0.8em;">
                  ${data.debugMessages.map(msg => `<li>${escapeHtml(msg)}</li>`).join('')}
                </ul>
              </div>
            `;
      }
      document.getElementById('rightPanel').innerHTML = `
            <div class="empty">${t('history.no_changes')}</div>
            ${debugHtml}
          `;


    }
  } catch (error) {
    console.error('Error loading script history:', error);
    let debugHtml = '';
    // If the error is from the fetch itself, data.debugMessages might not exist
    if (error.debugMessages && error.debugMessages.length > 0) {
      debugHtml = `
            <div class="debug-info" style="margin-top: 20px; padding: 10px; background-color: #333; border-radius: 5px;">
              <h4>Debug Information:</h4>
              <ul style="list-style-type: none; padding: 0; font-size: 0.8em;">
                ${error.debugMessages.map(msg => `<li>${escapeHtml(msg)}</li>`).join('')}
              </ul>
            </div>
          `;
    }
    document.getElementById('rightPanel').innerHTML = `
          <div class="empty">${t('history.error_loading', { error: error.message })}</div>
          ${debugHtml}
        `;


  }
}

function displayScriptHistory() {
  if (currentScriptHistory.length === 0) {
    document.getElementById('rightPanel').innerHTML = `<div class="empty">${t('history.no_changes')}</div>`;
    return;
  }

  // Build the HTML for the right panel with navigation
  const html = `
        <div class="file-history-viewer">
          <div class="file-history-header">
            <div class="file-history-info">
              <div class="history-position" id="scriptHistoryPosition">1 of ${currentScriptHistory.length}</div>
            </div>
            <div class="file-history-actions">
              <button class="btn" id="scriptPrevBtn" onclick="navigateScriptHistory(-1)" ${currentScriptHistoryIndex === 0 ? 'disabled' : ''} style="border: 1px solid var(--border-subtle); min-width: 36px; padding: 8px 12px;">◀</button>
              <button class="btn" id="scriptNextBtn" onclick="navigateScriptHistory(1)" ${currentScriptHistoryIndex === currentScriptHistory.length - 1 ? 'disabled' : ''} style="border: 1px solid var(--border-subtle); min-width: 36px; padding: 8px 12px;">▶</button>
            </div>
          </div>
          <div class="diff-view-container" id="scriptDiffContent"></div>
        </div>
      `;

  document.getElementById('rightPanel').innerHTML = html;

  // Show the floating button when viewing script history
  showFloatingConfirmRestoreButton();

  // Load the initial version
  loadScriptHistoryDiff();
}

async function loadScriptHistoryDiff() {
  const currentCommit = currentScriptHistory[currentScriptHistoryIndex];

  // Update position indicator
  // Update position indicator
  if (isScanningHistory) {
    document.getElementById('scriptHistoryPosition').textContent =
      `${currentScriptHistoryIndex + 1} — ${formatDateForBanner(currentCommit.date)} (${currentCommit.hash.substring(0, 8)})`;
  } else {
    document.getElementById('scriptHistoryPosition').textContent =
      `${currentScriptHistoryIndex + 1} of ${currentScriptHistory.length} — ${formatDateForBanner(currentCommit.date)} (${currentCommit.hash.substring(0, 8)})`;
  }

  // Update button states
  document.getElementById('scriptPrevBtn').disabled = currentScriptHistoryIndex === 0;
  document.getElementById('scriptNextBtn').disabled = currentScriptHistoryIndex === currentScriptHistory.length - 1;

  const script = allScripts.find(s => s.id === currentSelection.id);
  if (!script) return;

  const currentContent = dumpYaml(script.content);
  let leftContent = '';
  let rightContent = '';
  let leftLabel = '';
  let rightLabel = '';

  if (compareToCurrent) {
    // Compare to Current ON: Compare current version (left) vs commit version (right)
    const commitContent = currentCommit.yamlContent || dumpYaml(currentCommit.script);

    leftContent = currentContent;
    rightContent = commitContent;
    leftLabel = 'Current Version';
    rightLabel = formatDateForBanner(currentCommit.date);
  } else {
    // Compare to Current OFF: Compare parent (left) vs commit (right)
    const commitContent = currentCommit.yamlContent || dumpYaml(currentCommit.script);

    // Get parent content from the next item in history
    let parentContent = '';
    const parentIndex = currentScriptHistoryIndex + 1;
    if (parentIndex < currentScriptHistory.length) {
      const parentCommit = currentScriptHistory[parentIndex];
      parentContent = parentCommit.yamlContent || dumpYaml(parentCommit.script);
    }

    leftContent = parentContent;
    rightContent = commitContent;
    leftLabel = 'Before';
    rightLabel = formatDateForBanner(currentCommit.date);
  }

  const startLine = (script && script.line) ? (script.line - 1) : 0;

  // renderDiff expects (commitContent, currentContent) -> generateDiff(currentContent, commitContent)
  // So we pass (Right, Left) to renderDiff
  const diffHtml = renderDiff(rightContent, leftContent, document.getElementById('scriptDiffContent'), {
    leftLabel: leftLabel,
    rightLabel: rightLabel,
    startLineOffset: startLine,
    filePath: 'scripts.yaml'
  });
}

function navigateScriptHistory(direction) {
  const newIndex = currentScriptHistoryIndex + direction;

  if (newIndex < 0 || newIndex >= currentScriptHistory.length) {
    return; // Out of bounds
  }

  currentScriptHistoryIndex = newIndex;
  loadScriptHistoryDiff();
}

// Helper function to update navigation controls without reloading the diff
function updateScriptHistoryNavigation() {
  const historyPosition = document.getElementById('scriptHistoryPosition');
  const prevBtn = document.getElementById('scriptPrevBtn');
  const nextBtn = document.getElementById('scriptNextBtn');

  if (historyPosition && prevBtn && nextBtn) {
    const currentCommit = currentScriptHistory[currentScriptHistoryIndex];
    if (isScanningHistory) {
      historyPosition.textContent = `${currentScriptHistoryIndex + 1} — ${formatDateForBanner(currentCommit.date)} (${currentCommit.hash.substring(0, 8)})`;
    } else {
      historyPosition.textContent = `${currentScriptHistoryIndex + 1} of ${currentScriptHistory.length} — ${formatDateForBanner(currentCommit.date)} (${currentCommit.hash.substring(0, 8)})`;
    }

    // Update button states
    prevBtn.disabled = currentScriptHistoryIndex === 0;
    nextBtn.disabled = currentScriptHistoryIndex === currentScriptHistory.length - 1;
  }
}

// Helper function to dump YAML
function dumpYaml(obj) {
  if (typeof obj === 'string') return obj;
  try {
    // Use js-yaml to dump the object as YAML
    return jsyaml.dump(obj, {
      indent: 2,
      lineWidth: -1,  // Don't wrap lines
      noRefs: true,   // Don't use references
      sortKeys: false // Keep key order
    });
  } catch (error) {
    console.error('Error dumping YAML:', error);
    // Fallback to JSON if YAML dump fails
    return JSON.stringify(obj, null, 2);
  }
}

/**
 * Render unchanged content view (for files/automations/scripts with no history)
 * Uses the same format as timeline tab when showing unchanged files
 * @param {string} content - The content to display
 * @param {Object} options - Options for rendering
 * @param {number} options.startLineNum - Starting line number (default: 1)
 * @param {string} options.commitDate - Commit date (ISO format)
 * @param {string} options.commitHash - Commit hash
 * @returns {string} HTML string for the unchanged view
 */
function renderUnchangedView(content, options = {}) {
  const {
    startLineNum = 1,
    commitDate = null,
    commitHash = null,
    label = 'Current Version'
  } = options;

  // Split content into lines and trim empty ones from start/end
  let lines = content.split(/\r\n?|\n/);
  lines = trimEmptyLines(lines);

  // Use generateFullFileHTML to match timeline's unchanged file display
  let contentHtml = '';
  let lineNum = startLineNum - 1;

  lines.forEach(line => {
    lineNum++;
    contentHtml += `
      <div class="diff-line diff-line-context">
        <span class="diff-line-marker"> </span>
        <span class="diff-line-num">${lineNum}</span>
        <pre class="diff-line-text"><code>${escapeHtml(line) || '&nbsp;'}</code></pre>
      </div>
    `;
  });

  // Format commit date like "Nov 30, 2025 1:04 PM (2ec8a8d)"
  const formattedDate = commitDate ? formatDateForBanner(commitDate) : new Date().toLocaleDateString();
  const hashDisplay = commitHash ? ` (${commitHash.substring(0, 7)})` : '';

  // Wrap in file-history-viewer with header banner
  return `
    <div class="file-history-viewer">
      <div class="file-history-header">
        <div class="file-history-info">
          <div class="history-position">1 of 1 — ${formatDateForBanner(commitDate || new Date())} (${commitHash ? commitHash.substring(0, 8) : ''})</div>
        </div>
      </div>
      <div class="diff-view-container">
        <div class="segmented-control" style="cursor: default; grid-template-columns: 1fr;">
          <div class="segmented-control-slider" style="width: calc(100% - 8px);"></div>
          <label style="cursor: default; color: var(--text-primary);">${label}</label>
        </div>
        <div class="diff-viewer-shell ${currentDiffStyle}">
          <div class="diff-viewer-unified">
            ${contentHtml}
          </div>
        </div>
      </div>
    </div>
  `;
}



function generateClippedDiffHTML(baseLines, compareLines, context = 3, startLineOffset = 0) {
  const maxLines = Math.max(baseLines.length, compareLines.length);
  let diffHtml = '';

  const changedIndices = [];
  for (let i = 0; i < maxLines; i++) {
    const baseLine = baseLines[i] || '';
    const compareLine = compareLines[i] || '';
    if (baseLine !== compareLine) {
      changedIndices.push(i);
    }
  }

  if (changedIndices.length === 0) {
    return '';
  }

  let lastShownLine = -1;
  let lineNum = 0;

  for (let i = 0; i < maxLines; i++) {
    const showLine = changedIndices.some(ci => Math.abs(i - ci) <= context);

    if (showLine) {
      if (i > lastShownLine + 1) {
        diffHtml += `<div class="diff-line unchanged"><span class="line-num"></span><span class="line-content">...</span></div>`;
      }

      const baseLine = baseLines[i] || '';
      const compareLine = compareLines[i] || '';
      const isChanged = baseLine !== compareLine;
      lineNum = i + 1 + startLineOffset;

      if (isChanged) {
        if (compareLine && !baseLine) {
          // Line added in compare version
          diffHtml += `<div class="diff-line added"><span class="line-num"> </span><span class="line-content">+ ${escapeHtml(compareLine) || '&nbsp;'}</span></div>`;
        } else if (baseLine && !compareLine) {
          // Line removed from base version
          diffHtml += `<div class="diff-line removed"><span class="line-num">${lineNum}</span><span class="line-content">- ${escapeHtml(baseLine) || '&nbsp;'}</span></div>`;
        } else {
          // Line changed
          diffHtml += `<div class="diff-line removed"><span class="line-num">${lineNum}</span><span class="line-content">- ${escapeHtml(baseLine) || '&nbsp;'}</span></div>`;
          diffHtml += `<div class="diff-line added"><span class="line-num">${lineNum}</span><span class="line-content">+ ${escapeHtml(compareLine) || '&nbsp;'}</span></div>`;
        }
      } else {
        // Line unchanged
        diffHtml += `<div class="diff-line unchanged"><span class="line-number">${lineNum}</span><span class="line-content">  ${escapeHtml(baseLine) || '&nbsp;'}</span></div>`;
      }
      lastShownLine = i;
    }
  }
  if (lastShownLine < maxLines - 1 && changedIndices.length > 0) {
    if (maxLines - 1 - lastShownLine > 1)
      diffHtml += `<div class="diff-line unchanged"><span class="line-num"></span><span class="line-content">...</span></div>`;
  }

  return diffHtml;
}


function generateFullFileHTML(lines) {
  let contentHtml = '';
  let lineNum = 0;
  lines.forEach(line => {
    lineNum++;
    contentHtml += `
      <div class="diff-line diff-line-context">
        <span class="diff-line-marker"> </span>
        <span class="diff-line-num">${lineNum}</span>
        <pre class="diff-line-text"><code>${escapeHtml(line) || '&nbsp;'}</code></pre>
      </div>
    `;
  });
  return contentHtml;
}

function displayFileHistory(filePath) {
  if (currentFileHistory.length === 0) {
    document.getElementById('rightPanel').innerHTML = `<div class="empty">${t('files.empty_state')}</div>`;
    return;
  }

  // Set the panel title - add "(Added)" if the file was added
  let title = filePath;
  if (currentFileHistory.length > 0) {
    // Check if the oldest commit shows this file was added
    const oldestCommit = currentFileHistory[currentFileHistory.length - 1];
    if (oldestCommit && oldestCommit.status === 'A') {
      title += ' (Added)';
    }
  }
  document.getElementById('rightPanelTitle').textContent = title;
  // document.getElementById('itemsSubtitle').textContent = `History (${currentFileHistory.length} versions with changes)`;
  document.getElementById('rightPanelActions').innerHTML = '';

  // Build the HTML for the right panel with navigation
  const html = `
        <div class="file-history-viewer">
          <div class="file-history-header">
            <div class="file-history-info">
              <div class="history-position" id="historyPosition">1 of ${currentFileHistory.length}</div>
            </div>
                                          <div class="file-history-actions">
                                            <button class="btn" id="prevBtn" onclick="navigateFileHistory(-1)" ${currentFileHistoryIndex === 0 ? 'disabled' : ''} style="border: 1px solid var(--border-subtle); min-width: 36px; padding: 8px 12px;">◀</button>
                                            <button class="btn" id="nextBtn" onclick="navigateFileHistory(1)" ${currentFileHistoryIndex === currentFileHistory.length - 1 ? 'disabled' : ''} style="border: 1px solid var(--border-subtle); min-width: 36px; padding: 8px 12px;">▶</button>
                                          </div>          </div>
          <div class="diff-view-container" id="fileDiffContent"></div>
        </div>
      `;

  document.getElementById('rightPanel').innerHTML = html;

  // Show the floating button when viewing file history
  showFloatingConfirmRestoreButton();

  // Load the initial version
  loadFileHistoryDiff(filePath);
}

function formatDateForBanner(dateString) {
  const date = new Date(dateString);
  // Format: Nov 26, 2025 1:00 PM
  const datePart = date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
  const timePart = date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
  return `${datePart} ${timePart}`;
}

function trimEmptyLines(lines) {
  // Remove empty lines from the start
  while (lines.length > 0 && lines[0].trim() === '') {
    lines.shift();
  }
  // Remove empty lines from the end
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  return lines;
}



async function loadFileHistoryDiff(filePath) {
  const currentCommit = currentFileHistory[currentFileHistoryIndex];

  // Update position indicator
  // Update position indicator
  if (isScanningHistory) {
    document.getElementById('historyPosition').textContent =
      `${currentFileHistoryIndex + 1} — ${formatDateForBanner(currentCommit.date)} (${currentCommit.hash.substring(0, 8)})`;
  } else {
    document.getElementById('historyPosition').textContent =
      `${currentFileHistoryIndex + 1} of ${currentFileHistory.length} — ${formatDateForBanner(currentCommit.date)} (${currentCommit.hash.substring(0, 8)})`;
  }

  // Update button states
  document.getElementById('prevBtn').disabled = currentFileHistoryIndex === 0;
  document.getElementById('nextBtn').disabled = currentFileHistoryIndex === currentFileHistory.length - 1;

  // Check if this is a newly added file (using status from git log)
  const isNewlyAdded = currentCommit.status === 'A';

  let leftContent = '';
  let rightContent = '';
  let leftLabel = '';
  let rightLabel = '';

  if (compareToCurrent) {
    // Compare to Current ON: Compare current file to the selected version
    const currentContentResponse = await fetch(`${API}/file-content?filePath=${encodeURIComponent(filePath)}`);
    const currentContentData = await currentContentResponse.json();
    const currentContent = currentContentData.success ? currentContentData.content : '';

    if (isNewlyAdded) {
      // For newly added files, show the content as no-change diff
      leftContent = currentContent;
      rightContent = currentContent;
      leftLabel = 'Current Version';
      rightLabel = 'Current Version';
    } else {
      // Normal files: compare current to the version being viewed
      const commitResponse = await fetch(`${API}/git/file-at-commit?filePath=${encodeURIComponent(filePath)}&commitHash=${currentCommit.hash}`);
      const commitData = await commitResponse.json();
      const commitContent = commitData.success ? commitData.content : '';

      leftContent = commitContent;
      rightContent = currentContent;
      leftLabel = 'Current Version';
      rightLabel = formatDateForBanner(currentCommit.date);
    }
  } else {
    // Compare to Current OFF: Compare selected version to its parent (GitHub-style)
    // Get the version content
    const commitResponse = await fetch(`${API}/git/file-at-commit?filePath=${encodeURIComponent(filePath)}&commitHash=${currentCommit.hash}`);
    const commitData = await commitResponse.json();
    const commitContent = commitData.success ? commitData.content : '';

    if (isNewlyAdded) {
      // For newly added files, show all as additions (compare to empty)
      leftContent = '';
      rightContent = commitContent;
      leftLabel = 'Before';
      rightLabel = formatDateForBanner(currentCommit.date);
    } else {
      // Get the parent commit's version
      const parentResponse = await fetch(`${API}/git/file-at-commit?filePath=${encodeURIComponent(filePath)}&commitHash=${currentCommit.hash}^`);
      const parentData = await parentResponse.json();
      const parentContent = parentData.success ? parentData.content : '';

      leftContent = parentContent;
      rightContent = commitContent;
      leftLabel = 'Before';
      rightLabel = formatDateForBanner(currentCommit.date);
    }
  }

  // Render the diff
  const diffHtml = renderDiff(leftContent, rightContent, document.getElementById('fileDiffContent'), {
    leftLabel: leftLabel,
    rightLabel: rightLabel,
    filePath: filePath
  });

  // Show restore button only if compareToCurrent is ON and there are changes
  if (compareToCurrent && diffHtml && !isNewlyAdded) {
    document.getElementById('rightPanelActions').innerHTML = `<button class="btn restore" onclick="restoreFileVersion('${filePath}')" title="${t('diff.tooltip_overwrite_file')}">${t('timeline.restore_commit')}</button>`;
  } else {
    document.getElementById('rightPanelActions').innerHTML = '';
  }
}

function navigateFileHistory(direction) {
  const newIndex = currentFileHistoryIndex + direction;

  if (newIndex < 0 || newIndex >= currentFileHistory.length) {
    return; // Out of bounds
  }

  currentFileHistoryIndex = newIndex;
  const filePath = currentSelection.file;

  // Reload the diff for the new position
  loadFileHistoryDiff(filePath);
}

async function restoreFileVersion(filePath) {
  const currentCommit = currentFileHistory[currentFileHistoryIndex];
  const commitDate = new Date(currentCommit.date).toLocaleString();
  console.log(`[UI] User clicked restore for ${filePath} at commit ${currentCommit.hash.substring(0, 8)}`);

  // Restore directly without confirmation
  try {
    const response = await fetch(`${API}/restore-file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath, commitHash: currentCommit.hash })
    });
    const data = await response.json();

    if (data.success) {
      const key = data.reloaded ? 'timeline.single_file_restored_reloaded' : 'timeline.single_file_restored';
      const message = t(key).replace('{file}', filePath);

      // Check if it's a Lovelace file and offer restart
      if (filePath.includes('.storage/lovelace')) {
        showNotification(message, 'success', 8000, {
          label: 'Restart Home Assistant',
          callback: restartHomeAssistant
        });
      } else {
        showNotification(message, 'success');
      }

      // Reload the file history to show the new commit
      showFileHistory(filePath);
    } else {
      showNotification('Error: ' + data.error, 'error');
    }
  } catch (error) {
    console.error('Error:', error);
    showNotification('Error restoring file: ' + error.message, 'error');
  }
}

async function viewDiff(file, hash) {
  try {
    // Show loading state
    document.getElementById('modalTitle').textContent = 'Loading...';
    document.getElementById('diffModal').classList.add('active');

    // Get both the current file content and the commit version
    const [currentResponse, commitResponse, diffResponse] = await Promise.all([
      fetch(`${API}/files/content?path=${encodeURIComponent(file)}`),
      fetch(`${API}/git/file-at-commit?filePath=${encodeURIComponent(file)}&commitHash=${hash}`),
      fetch(`${API}/git/file-diff?filePath=${encodeURIComponent(file)}&commitHash=${hash}`)
    ]);

    const currentData = await currentResponse.json();
    const commitData = await commitResponse.json();
    const diffData = await diffResponse.json();

    if (commitData.success && currentData.success) {
      modalData = { file, hash, content: commitData.content };
      showModal(file, hash, commitData.content, currentData.content, diffData.diff);
    }
  } catch (error) {
    console.error('Error:', error);
    showNotification('Error loading file diff: ' + error.message, 'error');
  }
}

async function restoreAutomationVersion(automationId) {
  const auto = allAutomations.find(a => a.id === automationId);
  if (!auto) {
    showNotification('Automation not found', 'error');
    return;
  }

  try {
    // Get the commit hash from the current history position
    const currentCommit = currentAutomationHistory[currentAutomationHistoryIndex];
    const commitHash = currentCommit.hash;

    const response = await fetch(`${API}/automation/${encodeURIComponent(automationId)}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commitHash })
    });
    const data = await response.json();

    if (data.success) {
      const key = data.reloaded ? 'automations.automation_restored_reloaded' : 'automations.automation_restored';
      const message = t(key).replace('{name}', auto.name);
      showNotification(message);
      // Reload automations
      loadAutomations();
    } else {
      showNotification('Error: ' + data.error, 'error');
    }
  } catch (error) {
    console.error('Error:', error);
    showNotification('Error restoring automation: ' + error.message, 'error');
  }
}

async function restoreScriptVersion(scriptId) {
  const script = allScripts.find(s => s.id === scriptId);
  if (!script) {
    showNotification('Script not found', 'error');
    return;
  }

  try {
    // Get the commit hash from the current history position
    const currentCommit = currentScriptHistory[currentScriptHistoryIndex];
    const commitHash = currentCommit.hash;

    const response = await fetch(`${API}/script/${encodeURIComponent(scriptId)}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commitHash })
    });
    const data = await response.json();

    if (data.success) {
      const key = data.reloaded ? 'scripts.script_restored_reloaded' : 'scripts.script_restored';
      const message = t(key).replace('{name}', script.name);
      showNotification(message);
      // Reload scripts
      loadScripts();
    } else {
      showNotification('Error: ' + data.error, 'error');
    }
  } catch (error) {
    console.error('Error:', error);
    showNotification('Error restoring script: ' + error.message, 'error');
  }
}

function showModal(file, hash, commitContent, currentContent, diff) {
  document.getElementById('modalTitle').textContent = `Changes in ${file}`;
  document.getElementById('commitInfo').innerHTML =
    `<strong>Comparing:</strong> Commit ${hash.substring(0, 8)} (Left) vs Current Version (Right)`;

  renderDiff(commitContent, currentContent, diff, {
    leftLabel: `Version ${hash.substring(0, 8)}`,
    rightLabel: 'Current Version'
  });

  // Update the restore button to use the new confirmRestore function
  const restoreBtn = document.querySelector('#diffModal .btn-primary');
  if (restoreBtn) {
    restoreBtn.onclick = () => confirmRestore(file, hash);
  }
}


function renderDiff(commitContent, currentContent, diffText, options = {}) {
  const diffHtml = generateDiff(currentContent, commitContent, {
    leftLabel: options.leftLabel || 'Current Version',
    rightLabel: options.rightLabel || 'Backup Version',
    filePath: options.filePath || ''
  });

  // The new logic generates the entire HTML structure, so we need to inject it differently
  // We'll replace the entire diff-container content with the new structure
  const diffContainer = document.querySelector('.diff-container');
  diffContainer.innerHTML = diffHtml;
}

// Generate split diff with paired columns
function generateDiff(oldText, newText, options = {}) {
  const { leftLabel = 'Live version', rightLabel = 'Backup version', rightMeta = '', bannerText = '', returnNullIfNoChanges = false, startLineOffset = 0, filePath = '' } = options;

  // Ensure inputs are strings to prevent errors
  let safeOldText = typeof oldText === 'string' ? oldText : '';
  let safeNewText = typeof newText === 'string' ? newText : '';

  // Normalize YAML files to eliminate formatting differences
  const isYamlFile = filePath && /\.(yaml|yml)$/i.test(filePath);
  if (isYamlFile && typeof jsyaml !== 'undefined') {
    try {
      // Parse both versions
      const oldParsed = jsyaml.load(safeOldText);
      const newParsed = jsyaml.load(safeNewText);

      // Re-serialize with consistent formatting
      const yamlOptions = {
        indent: 2,
        lineWidth: -1,  // Don't wrap lines
        noRefs: true,   // Don't use references
        sortKeys: false // Keep original key order
      };

      safeOldText = jsyaml.dump(oldParsed, yamlOptions);
      safeNewText = jsyaml.dump(newParsed, yamlOptions);
    } catch (e) {
      // If YAML parsing fails, use original text
      console.warn('YAML parsing failed for diff normalization, using raw text:', e.message);
    }
  }

  // Store content for expand functionality AFTER normalization
  // Generate a unique ID for this diff context
  const diffId = `diff-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  diffContexts[diffId] = safeOldText;

  // Calculate total lines for bottom expander
  const totalLines = safeOldText.split(/\r\n?|\n/).length + startLineOffset;

  const diff = Diff.diffLines(safeOldText, safeNewText);
  const MAX_CONTEXT_LINES = 3; // Reduced to 3 for tighter diffs (YAML normalization eliminates formatting noise)

  const diffLines = [];
  let oldLineNum = 1 + startLineOffset;
  let newLineNum = 1 + startLineOffset;

  diff.forEach(part => {
    let lines = part.value.split('\n');
    if (lines.length && lines[lines.length - 1] === '') {
      lines.pop();
    }

    if (part.added) {
      lines.forEach(line => {
        diffLines.push({ type: 'added', text: line, oldLine: null, newLine: newLineNum });
        newLineNum++;
      });
    } else if (part.removed) {
      lines.forEach(line => {
        diffLines.push({ type: 'removed', text: line, oldLine: oldLineNum, newLine: null });
        oldLineNum++;
      });
    } else {
      lines.forEach(line => {
        diffLines.push({ type: 'context', text: line, oldLine: oldLineNum, newLine: newLineNum });
        oldLineNum++;
        newLineNum++;
      });
    }
  });

  const hunks = [];
  let index = 0;

  while (index < diffLines.length) {
    while (index < diffLines.length && diffLines[index].type === 'context') {
      index++;
    }

    if (index >= diffLines.length) break;

    let hunkStart = Math.max(0, index - MAX_CONTEXT_LINES);
    let hunkEnd = index;
    let postContextCount = 0;

    while (hunkEnd < diffLines.length) {
      const line = diffLines[hunkEnd];
      if (line.type === 'context') {
        postContextCount++;
        if (postContextCount > MAX_CONTEXT_LINES) {
          // Don't include this line - it should be part of separator/expander
          break;
        }
      } else {
        postContextCount = 0;
      }
      hunkEnd++;
    }

    const hunkLines = diffLines.slice(hunkStart, hunkEnd);
    const firstChangeIndex = hunkLines.findIndex(line => line.type !== 'context');

    const contextBefore = firstChangeIndex > 0 ? hunkLines.slice(0, firstChangeIndex) : [];
    const lines = firstChangeIndex >= 0 ? hunkLines.slice(firstChangeIndex) : hunkLines.slice();

    const oldLines = hunkLines.filter(line => line.oldLine !== null);
    const newLines = hunkLines.filter(line => line.newLine !== null);

    hunks.push({
      oldStart: oldLines.length ? oldLines[0].oldLine : (1 + startLineOffset),
      newStart: newLines.length ? newLines[0].newLine : (1 + startLineOffset),
      oldCount: oldLines.length,
      newCount: newLines.length,
      contextBefore,
      lines
    });

    index = hunkEnd;
  }

  if (!hunks.length) {
    if (returnNullIfNoChanges) return null;

    // Show the content as "Current Version" instead of empty state
    let lines = safeOldText.split(/\r\n?|\n/);
    lines = trimEmptyLines(lines);
    const lineCount = lines.length;

    let contentHtml = '';
    for (let i = 0; i < lineCount; i++) {
      contentHtml += `
        <div class="diff-line diff-line-context">
          <span class="diff-line-marker"> </span>
          <span class="diff-line-num">${i + 1 + startLineOffset}</span>
          <pre class="diff-line-text"><code>${escapeHtml(lines[i])}</code></pre>
        </div>
      `;
    }

    return `
      <div class="segmented-control" style="cursor: default; grid-template-columns: 1fr;">
        <div class="segmented-control-slider" style="width: calc(100% - 8px);"></div>
        <label style="cursor: default; color: var(--text-primary);">${leftLabel}</label>
      </div>
      <div class="diff-viewer-shell ${currentDiffStyle}">
        <div class="diff-viewer-unified">
          ${contentHtml}
        </div>
      </div>
    `;
  }

  // Generate style switcher was removed - now in settings
  const styleSwitcherHtml = '';

  // Choose rendering based on user preference
  if (diffViewFormat === 'split') {
    return `
      ${styleSwitcherHtml}
      <div class="segmented-control" style="cursor: default;">
        <input type="radio" name="diffHeaderSplit" id="diffHeaderLeft" checked disabled>
        <label for="diffHeaderLeft" style="cursor: default;">${leftLabel}</label>
        <input type="radio" name="diffHeaderSplit" id="diffHeaderRight" disabled>
        <label for="diffHeaderRight" style="cursor: default;">${rightLabel}</label>
        <div class="segmented-control-slider"></div>
      </div>
      <div class="diff-viewer-shell ${currentDiffStyle}">
        <div class="diff-viewer-split">
          ${renderHunksWithSeparators(hunks, 'split', totalLines, diffId, startLineOffset)}
        </div>
      </div>
    `;
  } else {
    // Unified format (default)
    return `
      ${styleSwitcherHtml}
      <div class="diff-header-unified">
        <div class="diff-header-text">
          ${leftLabel} vs ${rightLabel}
        </div>
      </div>
      <div class="diff-viewer-shell ${currentDiffStyle}">
        <div class="diff-viewer-unified">
          ${renderHunksWithSeparators(hunks, 'unified', totalLines, diffId, startLineOffset)}
        </div>
      </div>
    `;
  }
}

// Helper function to render hunks with separators for gaps
function renderHunksWithSeparators(hunks, format = 'unified', totalLines = 0, diffId = null, startLineOffset = 0) {
  if (hunks.length === 0) return '';

  const parts = [];

  // Add top expander if the first hunk doesn't start at line 1 (plus offset)
  if (hunks.length > 0) {
    const firstHunk = hunks[0];
    // Use oldStart because that refers to the original file line numbers
    const effectiveStartLine = 1 + startLineOffset;
    if (firstHunk.oldStart > effectiveStartLine) {
      const lineCount = firstHunk.oldStart - effectiveStartLine;
      const expanderId = `expander-top-${diffId || Date.now()}`;

      parts.push(`
        <div class="diff-expand-separator" id="${expanderId}" onclick="expandDiffContext('${expanderId}', ${effectiveStartLine}, ${firstHunk.oldStart - 1}, '${diffId}', ${startLineOffset}, '${format}')">
          <span class="diff-expand-icon">⋯</span> Expand ${lineCount} line${lineCount !== 1 ? 's' : ''} above
        </div>
      `);
    }
  }

  for (let i = 0; i < hunks.length; i++) {
    const currentHunk = hunks[i];
    const previousHunk = i > 0 ? hunks[i - 1] : null;

    // Add expandable separator if there's a gap between hunks
    if (previousHunk) {
      const prevOldEnd = previousHunk.oldStart + previousHunk.oldCount;
      // const prevNewEnd = previousHunk.newStart + previousHunk.newCount;
      const currentOldStart = currentHunk.oldStart;
      // const currentNewStart = currentHunk.newStart;
      const gap = currentOldStart - prevOldEnd;

      // If gap is larger than 0 lines, add an expandable separator
      if (gap > 0) {
        const lineCount = gap;
        const expanderId = `expander-${i}-${diffId || Date.now()}`;

        parts.push(`
          <div class="diff-expand-separator" id="${expanderId}" onclick="expandDiffContext('${expanderId}', ${prevOldEnd}, ${currentOldStart - 1}, '${diffId}', ${startLineOffset}, '${format}')">
            <span class="diff-expand-icon">⋯</span> Expand ${lineCount} line${lineCount !== 1 ? 's' : ''}
          </div>
        `);
      }
    }

    // Render the hunk
    if (format === 'split') {
      parts.push(renderSplitHunk(currentHunk, i));
    } else {
      parts.push(renderUnifiedHunk(currentHunk, i));
    }
  }

  // Add bottom expander if the last hunk doesn't end at the last line
  if (hunks.length > 0 && totalLines > 0) {
    const lastHunk = hunks[hunks.length - 1];
    const lastHunkEnd = lastHunk.oldStart + lastHunk.oldCount; // The line AFTER the last line of the hunk

    console.log('[BottomExpander] Debug:', {
      lastHunkOldStart: lastHunk.oldStart,
      lastHunkOldCount: lastHunk.oldCount,
      lastHunkEnd,
      totalLines,
      shouldShow: lastHunkEnd <= totalLines,
      diffId,
      startLineOffset
    });

    // If the hunk ends before the total lines
    // Note: oldStart is 1-based. If oldStart=1, oldCount=1, lastHunkEnd=2.
    // If totalLines=2, we want lines 2 to 2. So if lastHunkEnd <= totalLines
    if (lastHunkEnd <= totalLines) {
      const lineCount = totalLines - lastHunkEnd + 1;
      const expanderId = `expander-bottom-${diffId || Date.now()}`;

      parts.push(`
        <div class="diff-expand-separator" id="${expanderId}" onclick="expandDiffContext('${expanderId}', ${lastHunkEnd}, ${totalLines}, '${diffId}', ${startLineOffset}, '${format}')">
          <span class="diff-expand-icon">⋯</span> Expand ${lineCount} line${lineCount !== 1 ? 's' : ''} below
        </div>
      `);
    }
  }

  return parts.join('');
}

function renderDiff(commitContent, currentContent, targetElement = null, options = {}) {
  // If targetElement is a string, query it
  let container = targetElement;
  if (typeof targetElement === 'string') {
    container = document.querySelector(targetElement);
  }

  // Default to .diff-container if no target provided (backward compatibility for Timeline)
  if (!container) {
    container = document.querySelector('.diff-container');
  }

  if (!container) {
    console.error('renderDiff: Target container not found');
    return;
  }

  const diffHtml = generateDiff(currentContent, commitContent, {
    leftLabel: options.leftLabel || 'Current Version',
    rightLabel: options.rightLabel || 'Backup Version',
    startLineOffset: options.startLineOffset || 0,
    filePath: options.filePath || ''
  });

  container.innerHTML = diffHtml;
  return diffHtml; // Return content for check if needed
}

function renderUnifiedHunk(hunk, index) {
  const completeLines = [...(hunk.contextBefore || []), ...hunk.lines];

  // Pre-process lines to add character highlighting
  let i = 0;
  while (i < completeLines.length) {
    // Look for a block of removed lines followed by added lines
    if (completeLines[i].type === 'removed') {
      const removedBlock = [];
      const addedBlock = [];
      let j = i;

      // Collect consecutive removed lines
      while (j < completeLines.length && completeLines[j].type === 'removed') {
        removedBlock.push(completeLines[j]);
        j++;
      }

      // Collect consecutive added lines immediately following
      while (j < completeLines.length && completeLines[j].type === 'added') {
        addedBlock.push(completeLines[j]);
        j++;
      }

      // If we have both removed and added lines, try to highlight them
      if (removedBlock.length > 0 && addedBlock.length > 0) {
        const maxCount = Math.max(removedBlock.length, addedBlock.length);

        for (let k = 0; k < maxCount; k++) {
          const removedLine = removedBlock[k];
          const addedLine = addedBlock[k];

          if (removedLine && addedLine) {
            // Both exist, so we can diff them
            const { leftHtml, rightHtml } = highlightWordDiffs(removedLine.text, addedLine.text);
            removedLine.htmlContent = leftHtml;
            addedLine.htmlContent = rightHtml;
          }
          // If one exists but not the other, no highlighting needed (it's a full line add/remove)
        }
      }

      // Advance outer loop
      i = j;
    } else {
      i++;
    }
  }

  const rowsHtml = completeLines.map(line => renderUnifiedLine(line)).join('');

  return `
    <div class="diff-hunk" id="diff-hunk-${index}">
      ${rowsHtml}
    </div>
  `;
}

function renderUnifiedLine(line) {
  // Use pre-calculated HTML content if available, otherwise escape text
  const content = line.htmlContent || escapeHtml(line.text);

  if (line.type === 'context') {
    return `
      <div class="diff-line diff-line-context">
        <span class="diff-line-marker"> </span>
        <span class="diff-line-num">${line.oldLine || line.newLine || ''}</span>
        <pre class="diff-line-text"><code>${content}</code></pre>
      </div>
    `;
  } else if (line.type === 'added') {
    return `
      <div class="diff-line diff-line-added">
        <span class="diff-line-marker">+</span>
        <span class="diff-line-num">${line.newLine || ''}</span>
        <pre class="diff-line-text"><code>${content}</code></pre>
      </div>
    `;
  } else if (line.type === 'removed') {
    return `
      <div class="diff-line diff-line-removed">
        <span class="diff-line-marker">-</span>
        <span class="diff-line-num">${line.oldLine || ''}</span>
        <pre class="diff-line-text"><code>${content}</code></pre>
      </div>
    `;
  }
  return '';
}

function renderSplitHunk(hunk, index) {
  const oldCount = hunk.oldCount || 1;
  const newCount = hunk.newCount || 1;
  const oldEnd = oldCount ? hunk.oldStart + oldCount - 1 : hunk.oldStart;
  const newEnd = newCount ? hunk.newStart + newCount - 1 : hunk.newStart;
  const summary = `Lines ${hunk.oldStart}${oldEnd !== hunk.oldStart ? `-${oldEnd}` : ''} → ${hunk.newStart}${newEnd !== hunk.newStart ? `-${newEnd}` : ''}`;
  const completeLines = [...(hunk.contextBefore || []), ...hunk.lines];
  const rowsHtml = renderSplitRows(completeLines);
  const contextLineCount = completeLines.filter(line => line.type === 'context').length;
  const hunkId = `diff-hunk-${index}`;
  const showLabel = 'Expand context';
  const hideLabel = 'Collapse context';

  // We're simplifying context toggling for now by always showing it expanded or just not hiding it
  // But we'll keep the structure ready
  const buttonHtml = '';
  const hunkClasses = 'diff-hunk';

  return `
    <div class="${hunkClasses}" id="${hunkId}">
      <div class="diff-hunk-content">
        ${rowsHtml}
      </div>
      <div class="diff-hunk-footer">
        <div class="diff-hunk-summary" style="display: none;">${summary}</div>
        ${buttonHtml}
      </div>
    </div>
  `;
}

function renderSplitRows(lines) {
  const rows = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (line.type === 'context') {
      rows.push(renderSplitRow(
        {
          type: 'context',
          text: line.text,
          lineNumber: line.oldLine,
          marker: ''
        },
        {
          type: 'context',
          text: line.text,
          lineNumber: line.newLine,
          marker: ''
        }
      ));
      index++;
      continue;
    }

    if (line.type === 'removed') {
      const removed = [];
      const added = [];

      while (index < lines.length && lines[index].type === 'removed') {
        removed.push(lines[index]);
        index++;
      }

      while (index < lines.length && lines[index].type === 'added') {
        added.push(lines[index]);
        index++;
      }

      const maxRows = Math.max(removed.length, added.length);
      for (let i = 0; i < maxRows; i++) {
        rows.push(renderSplitRow(
          removed[i]
            ? {
              type: 'removed',
              text: removed[i].text,
              lineNumber: removed[i].oldLine,
              marker: '-'
            }
            : {
              type: 'empty',
              text: '',
              lineNumber: null,
              marker: ''
            },
          added[i]
            ? {
              type: 'added',
              text: added[i].text,
              lineNumber: added[i].newLine,
              marker: '+'
            }
            : {
              type: 'empty',
              text: '',
              lineNumber: null,
              marker: ''
            }
        ));
      }

      continue;
    }

    if (line.type === 'added') {
      const added = [];

      while (index < lines.length && lines[index].type === 'added') {
        added.push(lines[index]);
        index++;
      }

      added.forEach(entry => {
        rows.push(renderSplitRow(
          {
            type: 'empty',
            text: '',
            lineNumber: null,
            marker: ''
          },
          {
            type: 'added',
            text: entry.text,
            lineNumber: entry.newLine,
            marker: '+'
          }
        ));
      });

      continue;
    }

    rows.push(renderSplitRow(
      {
        type: line.type,
        text: line.text,
        lineNumber: line.oldLine,
        marker: ' '
      },
      {
        type: line.type,
        text: line.text,
        lineNumber: line.newLine,
        marker: ' '
      }
    ));
    index++;
  }

  return rows.join('');
}

function renderSplitRow(left, right) {
  // Check if we have a modified line (both sides present and not context/empty)
  if (left.type === 'removed' && right.type === 'added') {
    const { leftHtml, rightHtml } = highlightWordDiffs(left.text, right.text);
    left.htmlContent = leftHtml;
    right.htmlContent = rightHtml;
  }

  return `
    <div class="diff-row ${left.type === 'context' && right.type === 'context' ? 'diff-row-context' : ''}">
      <div class="diff-cell diff-cell-left">
        ${renderLineContent(left, 'left')}
      </div>
      <div class="diff-cell diff-cell-right">
        ${renderLineContent(right, 'right')}
      </div>
    </div>
  `;
}

function highlightWordDiffs(oldText, newText) {
  // Use Diff.diffWords to find word-level differences
  const diff = Diff.diffWords(oldText, newText);
  let leftHtml = '';
  let rightHtml = '';

  diff.forEach(part => {
    const escapedValue = escapeHtml(part.value);
    if (part.added) {
      rightHtml += `<span class="diff-word-add">${escapedValue}</span>`;
    } else if (part.removed) {
      leftHtml += `<span class="diff-word-rem">${escapedValue}</span>`;
    } else {
      leftHtml += escapedValue;
      rightHtml += escapedValue;
    }
  });

  return { leftHtml, rightHtml };
}

function renderLineContent(line, position) {
  if (line.type === 'empty') {
    return '<div class="diff-line diff-line-empty"></div>';
  }

  const marker = line.marker || (line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ');
  const lineNum = line.lineNumber || '';
  const lineClass = `diff-line diff-line-${line.type}`;

  return `
    <div class="${lineClass} diff-line-${position}">
      <span class="diff-line-marker">${marker}</span>
      <span class="diff-line-num">${lineNum}</span>
      <pre class="diff-line-text"><code>${line.htmlContent || escapeHtml(line.text)}</code></pre>
    </div>
  `;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Store original content for expand functionality
const diffContexts = {}; // Map of diffId -> oldText

function expandDiffContext(expanderId, startLine, endLine, diffId, offset = 0, format = 'unified') {
  const expander = document.getElementById(expanderId);
  if (!expander) return;

  // Retrieve content from the specific diff context
  const content = diffContexts[diffId];

  // If no stored content, can't expand
  if (!content) {
    expander.textContent = t('diff.content_not_available');
    return;
  }

  const lines = content.split(/\r\n?|\n/);
  // Adjust slicing for offset
  const startIndex = Math.max(0, startLine - 1 - offset);
  const endIndex = Math.max(0, endLine - offset);
  let contextLines = lines.slice(startIndex, endIndex);

  // Remove empty lines from top and bottom
  contextLines = trimEmptyLines(contextLines);

  // Build HTML for context lines
  let contextHtml = '';
  for (let i = 0; i < contextLines.length; i++) {
    const lineNum = startLine + i;
    const lineText = contextLines[i];
    const escapedText = escapeHtml(lineText);

    if (format === 'split') {
      contextHtml += `
        <div class="diff-row diff-row-context">
          <div class="diff-cell diff-cell-left">
            <div class="diff-line diff-line-context diff-line-left">
              <span class="diff-line-marker"> </span>
              <span class="diff-line-num">${lineNum}</span>
              <pre class="diff-line-text"><code>${escapedText}</code></pre>
            </div>
          </div>
          <div class="diff-cell diff-cell-right">
            <div class="diff-line diff-line-context diff-line-right">
              <span class="diff-line-marker"> </span>
              <span class="diff-line-num">${lineNum}</span>
              <pre class="diff-line-text"><code>${escapedText}</code></pre>
            </div>
          </div>
        </div>
      `;
    } else {
      contextHtml += `
        <div class="diff-line diff-line-context">
          <span class="diff-line-marker"> </span>
          <span class="diff-line-num">${lineNum}</span>
          <pre class="diff-line-text"><code>${escapedText}</code></pre>
        </div>
      `;
    }
  }

  // Replace expander with context lines
  expander.outerHTML = contextHtml;
}

function closeModal() {
  document.getElementById('diffModal').classList.remove('active');
  modalData = null;
}

// Restore preview modal functions

function closeRestorePreview() {
  document.getElementById('restorePreviewModal').classList.remove('active');
  restorePreviewData = null;
}

function showNotification(message, type = 'success', duration = 3000, action = null) {
  // Create notification element
  const notification = document.createElement('div');
  notification.className = `notification ${type}`;

  const messageSpan = document.createElement('span');
  messageSpan.textContent = message;
  notification.appendChild(messageSpan);

  if (action) {
    const actionBtn = document.createElement('button');
    actionBtn.className = 'notification-action-btn';
    actionBtn.textContent = action.label;
    actionBtn.onclick = () => {
      action.callback();
      notification.remove();
    };
    notification.appendChild(actionBtn);

    // Extend duration if there's an action
    if (duration === 3000) duration = 8000;
  }

  // Add to page
  document.body.appendChild(notification);

  // Auto-remove after specified duration
  setTimeout(() => {
    notification.style.animation = 'notificationSlideOut 0.3s ease-in';
    setTimeout(() => {
      if (notification.parentNode) {
        notification.remove();
      }
    }, 300);
  }, duration);
}

async function restartHomeAssistant() {
  try {
    // Just fire off the request silently - we don't care about the response
    // Any response (success, 504, timeout, etc.) means the restart is happening
    fetch(`${API}/ha/restart`, { method: 'POST' }).catch(() => {
      // Ignore errors - they're expected during restart
    });
  } catch (error) {
    // This shouldn't happen, but log it just in case
    console.log('Restart initiated:', error);
  }
}

async function showRestorePreview(filePath, commitHash, commitDate) {
  console.log(`[UI] Loading restore preview for ${filePath} at commit ${commitHash.substring(0, 8)}`);

  try {
    // Show modal immediately with loading state
    document.getElementById('restorePreviewTitle').textContent = `Preview Restore: ${filePath}`;
    document.getElementById('restorePreviewInfo').innerHTML =
      `<strong>Restoring to:</strong> ${commitDate}<br>
           <strong>Commit:</strong> ${commitHash.substring(0, 8)}<br>
           <strong>Note:</strong> This will OVERWRITE the current file on disk<br>
           <div style="margin-top: 8px; font-size: 12px; color: var(--text-tertiary);">
             This view shows your current file compared to the selected version
           </div>`;

    document.getElementById('restoreDiffContent').innerHTML = '<div class="empty">Loading diff...</div>';
    document.getElementById('restorePreviewModal').classList.add('active');

    // Get both current file and commit version in parallel
    const [currentResponse, commitResponse] = await Promise.all([
      fetch(`${API}/file-content?filePath=${encodeURIComponent(filePath)}`),
      fetch(`${API}/git/file-at-commit?filePath=${encodeURIComponent(filePath)}&commitHash=${commitHash}`)
    ]);

    const currentData = await currentResponse.json();
    const commitData = await commitResponse.json();

    if (!commitData.success) {
      showNotification('Error loading file version for preview', 'error');
      return;
    }

    // Render single-column diff
    const currentLines = currentData.success ? currentData.content.split(/\r\n?|\n/) : [];
    const commitLines = commitData.content.split(/\r\n?|\n/);
    const diffHtml = generateClippedDiffHTML(currentLines, commitLines, 3);


    document.getElementById('restoreDiffContent').innerHTML = diffHtml || `<div class="empty">${t('diff.file_empty')}</div>`;

    // Store data for restore
    restorePreviewData = { filePath, commitHash };
    console.log(`[UI] Restore preview loaded successfully`);

  } catch (error) {
    console.error('Error loading restore preview:', error);
    showNotification('Error loading restore preview: ' + error.message, 'error');
    closeRestorePreview();
  }
}

async function showAutomationRestorePreview(automationId, commitHash, commitDate) {
  console.log(`[UI] Loading automation restore preview for ${automationId} at commit ${commitHash.substring(0, 8)}`);

  try {
    const auto = allAutomations.find(a => a.id === automationId);
    if (!auto) {
      showNotification('Automation not found', 'error');
      return;
    }

    // Show modal immediately with loading state
    document.getElementById('restorePreviewTitle').textContent = `Preview Restore: ${auto.name}`;
    document.getElementById('restorePreviewInfo').innerHTML =
      `<strong>Automation:</strong> ${auto.name}<br>
           <strong>Restoring to:</strong> ${commitDate}<br>
           <strong>Commit:</strong> ${commitHash.substring(0, 8)}<br>
           <strong>Note:</strong> This will OVERWRITE the current automation<br>
           <div style="margin-top: 8px; font-size: 12px; color: var(--text-tertiary);">
             This view shows your current automation compared to the selected version
           </div>`;

    document.getElementById('restoreDiffContent').innerHTML = '<div class="empty">Loading diff...</div>';
    document.getElementById('restorePreviewModal').classList.add('active');

    // Get the automation history and find the specific commit
    const response = await fetch(`${API}/automation/${encodeURIComponent(automationId)}/history`);
    const data = await response.json();

    if (!data.success) {
      showNotification('Error loading automation history for preview', 'error');
      return;
    }

    // Find the commit in history
    const commit = data.history.find(c => c.hash === commitHash);
    if (!commit) {
      showNotification('Commit not found in automation history', 'error');
      return;
    }

    // Get current and commit content
    const currentContent = dumpYaml(auto.content);
    const commitContent = dumpYaml(commit.automation);

    // Render single-column diff
    const currentLines = currentContent.split(/\r\n?|\n/);
    const commitLines = commitContent.split(/\r\n?|\n/);
    const diffHtml = generateClippedDiffHTML(currentLines, commitLines, 3);

    document.getElementById('restoreDiffContent').innerHTML = diffHtml || `<div class="empty">${t('diff.no_changes')}</div>`;

    // Store data for restore
    restorePreviewData = { automationId, commitHash };
    console.log(`[UI] Automation restore preview loaded successfully`);

  } catch (error) {
    console.error('Error loading automation restore preview:', error);
    showNotification('Error loading automation restore preview: ' + error.message, 'error');
    closeRestorePreview();
  }
}

async function showScriptRestorePreview(scriptId, commitHash, commitDate) {
  console.log(`[UI] Loading script restore preview for ${scriptId} at commit ${commitHash.substring(0, 8)}`);

  try {
    const script = allScripts.find(s => s.id === scriptId);
    if (!script) {
      showNotification('Script not found', 'error');
      return;
    }

    // Show modal immediately with loading state
    document.getElementById('restorePreviewTitle').textContent = `Preview Restore: ${script.name}`;
    document.getElementById('restorePreviewInfo').innerHTML =
      `<strong>Script:</strong> ${script.name}<br>
           <strong>Restoring to:</strong> ${commitDate}<br>
           <strong>Commit:</strong> ${commitHash.substring(0, 8)}<br>
           <strong>Note:</strong> This will OVERWRITE the current script<br>
           <div style="margin-top: 8px; font-size: 12px; color: var(--text-tertiary);">
             This view shows your current script compared to the selected version
           </div>`;

    document.getElementById('restoreDiffContent').innerHTML = '<div class="empty">Loading diff...</div>';
    document.getElementById('restorePreviewModal').classList.add('active');

    // Get the script history and find the specific commit
    const response = await fetch(`${API}/script/${encodeURIComponent(scriptId)}/history`);
    const data = await response.json();

    if (!data.success) {
      showNotification('Error loading script history for preview', 'error');
      return;
    }

    // Find the commit in history
    const commit = data.history.find(c => c.hash === commitHash);
    if (!commit) {
      showNotification('Commit not found in script history', 'error');
      return;
    }

    // Get current and commit content
    const currentContent = dumpYaml(script.content);
    const commitContent = dumpYaml(commit.script);

    // Render single-column diff
    const currentLines = currentContent.split(/\r\n?|\n/);
    const commitLines = commitContent.split(/\r\n?|\n/);
    const diffHtml = generateClippedDiffHTML(currentLines, commitLines, 3);

    document.getElementById('restoreDiffContent').innerHTML = diffHtml || `<div class="empty">${t('diff.no_changes')}</div>`;

    // Store data for restore
    restorePreviewData = { scriptId, commitHash };
    console.log(`[UI] Script restore preview loaded successfully`);

  } catch (error) {
    console.error('Error loading script restore preview:', error);
    showNotification('Error loading script restore preview: ' + error.message, 'error');
    closeRestorePreview();
  }
}

async function showCommitRestorePreview(commitHash, commitDate) {
  console.log(`[UI] Loading commit restore preview for ${commitHash.substring(0, 8)}`);

  try {
    // Get commit info
    const commit = allCommits.find(c => c.hash === commitHash);
    const commitMessage = commit ? commit.message : '';

    // If commitDate is not provided, try to get it from the commit object
    if (!commitDate && commit) {
      commitDate = new Date(commit.date).toLocaleString();
    }

    // Show modal immediately with loading state
    document.getElementById('restorePreviewTitle').textContent = `Preview Restore: Commit ${commitHash.substring(0, 8)}`;
    document.getElementById('restorePreviewInfo').innerHTML =
      `<strong>Restoring to:</strong> ${commitDate}<br>
           <strong>Commit:</strong> ${commitHash.substring(0, 8)}<br>
           <strong>Message:</strong> ${commitMessage}<br>
           <strong>Note:</strong> This will restore all files changed in this commit<br>
           <div style="margin-top: 8px; font-size: 12px; color: var(--text-tertiary);">
             This view shows the changes that will be applied to your files
           </div>`;

    document.getElementById('restoreDiffContent').innerHTML = '<div class="empty">Loading diff...</div>';
    document.getElementById('restorePreviewModal').classList.add('active');

    // First get the list of files in this commit
    const detailsResponse = await fetch(`${API}/git/commit-details?commitHash=${commitHash}`);
    const detailsData = await detailsResponse.json();

    if (!detailsData.success) {
      showNotification('Error loading commit details for preview', 'error');
      return;
    }

    // Parse files from status
    const lines = detailsData.status.split('\n').filter(line => line.trim());
    const files = lines.slice(1).map(line => {
      const parts = line.split('\t');
      return { status: parts[0], file: parts[1] };
    }).filter(f => f.file);

    // For each file, get current content and commit version, then compare
    let allDiffsHtml = '';

    for (const file of files) {
      try {
        // Get current file content
        const currentResponse = await fetch(`${API}/file-content?filePath=${encodeURIComponent(file.file)}`);
        const currentData = await currentResponse.json();
        const currentContent = currentData.success ? currentData.content : '';

        // Get commit version content
        const commitResponse = await fetch(`${API}/git/file-at-commit?filePath=${encodeURIComponent(file.file)}&commitHash=${commitHash}`);
        const commitData = await commitResponse.json();
        const commitContent = commitData.success ? commitData.content : '';

        // Compare them
        const currentLines = currentContent.split(/\r\n?|\n/);
        const commitLines = commitContent.split(/\r\n?|\n/);
        const diffHtml = generateClippedDiffHTML(currentLines, commitLines, 3);

        // Add file header if there's a diff
        if (diffHtml.trim()) {
          allDiffsHtml += `<div class="diff-view-container">
                <div style="color: var(--text-secondary); font-size: 12px; margin-bottom: 8px; font-weight: bold;">
                  ${file.file} (${file.status === 'A' ? 'Added' : file.status === 'D' ? 'Deleted' : 'Modified'})
                </div>
                ${diffHtml}
              </div>`;
        }
      } catch (error) {
        console.error(`Error comparing file ${file.file}:`, error);
      }
    }

    if (allDiffsHtml) {
      document.getElementById('restoreDiffContent').innerHTML = allDiffsHtml;
    } else {
      document.getElementById('restoreDiffContent').innerHTML = `<div class="empty">${t('diff.no_changes_detected')}</div>`;
    }

    // Store data for restore
    restorePreviewData = { commitHash };
    console.log(`[UI] Commit restore preview loaded successfully`);

  } catch (error) {
    console.error('Error loading commit restore preview:', error);
    showNotification('Error loading commit restore preview: ' + error.message, 'error');
    closeRestorePreview();
  }
}

async function doRestore() {
  if (!restorePreviewData) {
    showNotification('No restore data available', 'error');
    return;
  }

  const { filePath, commitHash, automationId, scriptId } = restorePreviewData;

  try {
    console.log(`[UI] Confirming restore...`);

    if (filePath) {
      // Restore file
      const response = await fetch(`${API}/restore-file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath, commitHash })
      });
      const data = await response.json();

      if (data.success) {
        const key = data.reloaded ? 'timeline.single_file_restored_reloaded' : 'timeline.single_file_restored';
        const message = t(key).replace('{file}', filePath);

        // Check if it's a Lovelace file and offer restart
        if (filePath.includes('.storage/lovelace')) {
          showNotification(message, 'success', 8000, {
            label: 'Restart Home Assistant',
            callback: restartHomeAssistant
          });
        } else {
          showNotification(message, 'success');
        }

        closeRestorePreview();
        refreshCurrent();
      } else {
        showNotification('Error: ' + data.error, 'error');
      }
    } else if (commitHash && !automationId && !scriptId) {
      // Restore commit (no filePath means this is a commit restore from History tab)
      const response = await fetch(`${API}/restore-commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commitHash })
      });
      const data = await response.json();

      if (data.success) {
        // Build message based on what was reloaded
        const files = data.files || [];
        const fileNames = files.join(', ');

        let message;
        if (data.automationReloaded || data.scriptReloaded) {
          // Show "restored and reloaded" message like other tabs
          message = t('timeline.files_restored_and_reloaded', { files: fileNames });
        } else {
          // Simple restored message
          message = t('timeline.files_restored', { files: fileNames });
        }

        showNotification(message);
        closeRestorePreview();
        refreshCurrent();
      } else {
        showNotification('Error: ' + data.error, 'error');
      }
    } else if (automationId) {
      // Restore automation
      const response = await fetch(`${API}/automation/${encodeURIComponent(automationId)}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commitHash })
      });
      const data = await response.json();

      if (data.success) {
        const auto = allAutomations.find(a => a.id === automationId);
        const key = data.reloaded ? 'automations.automation_restored_reloaded' : 'automations.automation_restored';
        const message = t(key).replace('{name}', auto ? auto.name : automationId);
        showNotification(message);
        closeRestorePreview();
        loadAutomations();
      } else {
        showNotification('Error: ' + data.error, 'error');
      }
    } else if (scriptId) {
      // Restore script
      const response = await fetch(`${API}/script/${encodeURIComponent(scriptId)}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commitHash })
      });
      const data = await response.json();

      if (data.success) {
        const script = allScripts.find(s => s.id === scriptId);
        const key = data.reloaded ? 'scripts.script_restored_reloaded' : 'scripts.script_restored';
        const message = t(key).replace('{name}', script ? script.name : scriptId);
        showNotification(message);
        closeRestorePreview();
        loadScripts();
      } else {
        showNotification('Error: ' + data.error, 'error');
      }
    } else {
      showNotification('Unknown restore type', 'error');
    }
  } catch (error) {
    console.error('Error:', error);
    showNotification('Error restoring: ' + error.message, 'error');
  }
}


async function confirmRestore(file, hash) {
  try {
    const response = await fetch(`${API}/restore-file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filePath: file,
        commitHash: hash
      })
    });

    const result = await response.json();

    if (result.success) {
      const key = result.reloaded ? 'timeline.single_file_restored_reloaded' : 'timeline.single_file_restored';
      const message = t(key).replace('{file}', file);

      // Check if it's a Lovelace file and offer restart
      if (file.includes('.storage/lovelace')) {
        showNotification(message, 'success', 8000, {
          label: 'Restart Home Assistant',
          callback: restartHomeAssistant
        });
      } else {
        showNotification(message, 'success');
      }

      closeModal();
      refreshCurrent();
    }
  } catch (error) {
    console.error('Error:', error);
    showNotification('Error restoring file: ' + error.message, 'error');
  }
}

async function viewFileAtCommit(file, hash) {
  try {
    const response = await fetch(`${API}/git/file-at-commit?filePath=${encodeURIComponent(file)}&commitHash=${hash}`);
    const data = await response.json();

    if (data.success) {
      modalData = { file, hash, content: data.content };
      showModal(file, hash, data.content, '');
    }
  } catch (error) {
    console.error('Error:', error);
  }
}

async function restoreFile(file, hash) {
  try {
    const response = await fetch(`${API}/restore-file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: file, commitHash: hash })
    });
    const data = await response.json();

    if (data.success) {
      const key = data.reloaded ? 'timeline.single_file_restored_reloaded' : 'timeline.single_file_restored';
      const message = t(key).replace('{file}', file);

      // Check if it's a Lovelace file and offer restart
      if (file.includes('.storage/lovelace')) {
        showNotification(message, 'success', 8000, {
          label: 'Restart Home Assistant',
          callback: restartHomeAssistant
        });
      } else {
        showNotification(message, 'success');
      }

      refreshCurrent();
    } else {
      showNotification('Error: ' + data.error, 'error');
    }
  } catch (error) {
    console.error('Error:', error);
    showNotification('Error restoring file: ' + error.message, 'error');
  }
}

async function restoreCommit(sourceHash, targetHash) {
  try {
    const response = await fetch(`${API}/restore-commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceHash: sourceHash,
        targetHash: targetHash
      })
    });
    const data = await response.json();

    if (data.success) {
      let message = '';
      const isReloaded = data.automationReloaded || data.scriptReloaded;

      if (data.files && data.files.length === 1) {
        // Single file restored
        const filePath = data.files[0];
        // Use full path or relative path, not just filename to be more descriptive
        const key = isReloaded ? 'timeline.single_file_restored_reloaded' : 'timeline.single_file_restored';
        message = t(key).replace('{file}', filePath);

        // Check if it's a Lovelace file and offer restart
        if (filePath.includes('.storage/lovelace')) {
          showNotification(message, 'success', 8000, {
            label: 'Restart Home Assistant',
            callback: restartHomeAssistant
          });
          refreshCurrent();
          return; // Exit early since we handled notification
        }
      } else if (data.files && data.files.length > 1) {
        // Multiple files restored
        const key = isReloaded ? 'timeline.multiple_files_restored_reloaded' : 'timeline.multiple_files_restored';
        message = t(key).replace('{count}', data.files.length);

        // Check if any are Lovelace files
        const hasLovelace = data.files.some(f => f.includes('.storage/lovelace'));
        if (hasLovelace) {
          showNotification(message, 'success', 8000, {
            label: 'Restart Home Assistant',
            callback: restartHomeAssistant
          });
          refreshCurrent();
          return; // Exit early
        }
      } else {
        // Fallback
        message = data.message || t('timeline.commit_restored');
      }

      showNotification(message, 'success');
      refreshCurrent();
    } else {
      showNotification('Error: ' + data.error, 'error');
    }
  } catch (error) {
    console.error('Error:', error);
    showNotification('Error restoring commit: ' + error.message, 'error');
  }
}

// Long-press handling for hard reset
let restorePressTimer = null;
let restorePressStage = 0; // 0=normal, 1=holding, 2=unlocked
let currentRestoreSourceHash = null;
let currentRestoreTargetHash = null;

function handleRestoreButtonDown(sourceHash, targetHash) {
  currentRestoreSourceHash = sourceHash;
  currentRestoreTargetHash = targetHash;
  restorePressStage = 1;

  const btn = document.getElementById('restore-commit-btn');
  if (!btn) return;

  // Start timer for 2 seconds - no visual feedback until unlock
  restorePressTimer = setTimeout(() => {
    restorePressStage = 2;
    btn.classList.add('unlocked');

    // Update button text
    const textEl = document.getElementById('restore-btn-text');
    if (textEl) {
      textEl.textContent = t('timeline.reset_all_files');
    }

    // Haptic feedback if available
    if (navigator.vibrate) {
      navigator.vibrate(50);
    }
  }, 2000);
}

function handleRestoreButtonUp(sourceHash, targetHash) {
  clearTimeout(restorePressTimer);

  const btn = document.getElementById('restore-commit-btn');

  if (restorePressStage === 2) {
    // Unlocked! Show hard reset confirmation
    // For hard reset, use targetHash (the version to reset to)
    showHardResetConfirmation(targetHash);
  } else {
    // Normal click - restore just this commit's files
    restoreCommit(sourceHash, targetHash);
  }

  // Reset state
  resetRestoreButtonState();
}

function handleRestoreButtonCancel() {
  clearTimeout(restorePressTimer);
  resetRestoreButtonState();
}

function resetRestoreButtonState() {
  restorePressStage = 0;
  currentRestoreSourceHash = null;
  currentRestoreTargetHash = null;

  const btn = document.getElementById('restore-commit-btn');
  if (btn) {
    btn.classList.remove('unlocked');
  }

  const textEl = document.getElementById('restore-btn-text');
  if (textEl && textEl.textContent === 'RESET ALL FILES') {
    textEl.textContent = t('timeline.restore_commit');
  }
}

function showHardResetConfirmation(hash) {
  // Find the commit info
  const commit = allCommits.find(c => c.hash === hash);

  let formattedDate = 'Unknown';
  if (commit) {
    const dateObj = new Date(commit.date);
    // Format: Nov 26 2025 7:30:51 AM (remove commas)
    const options = {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hour12: true
    };
    formattedDate = dateObj.toLocaleString('en-US', options).replace(/,/g, '');
  }

  // Create minimal modal HTML
  const modalHTML = `
    <div class="modal-backdrop active" id="hard-reset-modal" onclick="if(event.target === this) closeHardResetModal()">
      <div class="modal-content hard-reset-dialog">
        <h3>${t('restore_preview.reset_all_title')}</h3>
        
        <p>${t('restore_preview.reset_all_message', { date: formattedDate })}</p>
        
        <div class="modal-actions">
          <button class="btn btn-secondary" onclick="closeHardResetModal()">${t('restore_preview.cancel')}</button>
          <button class="btn btn-danger" onclick="confirmHardReset('${hash}')">${t('timeline.reset_all_files')}</button>
        </div>
      </div>
    </div>
  `;

  // Add to body
  document.body.insertAdjacentHTML('beforeend', modalHTML);

  // Focus cancel button by default
  setTimeout(() => {
    const cancelBtn = document.querySelector('#hard-reset-modal .btn-secondary');
    if (cancelBtn) cancelBtn.focus();
  }, 100);
}

function closeHardResetModal() {
  const modal = document.getElementById('hard-reset-modal');
  if (modal) {
    modal.remove();
  }
  resetRestoreButtonState();
}

async function confirmHardReset(hash) {
  closeHardResetModal();

  try {
    showNotification('Creating safety backup and resetting...', 'info', 5000);

    const response = await fetch(`${API}/git/hard-reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commitHash: hash,
        createBackup: true
      })
    });

    const data = await response.json();

    if (data.success) {
      const backupMsg = data.backupCommitHash
        ? ` Safety backup created at ${data.backupCommitHash.substring(0, 8)}.`
        : '';
      showNotification(
        `All files reset to commit ${hash.substring(0, 8)}.${backupMsg} Refreshing...`,
        'success',
        5000
      );

      // Refresh the view
      setTimeout(() => {
        window.location.reload();
      }, 1500);
    } else {
      showNotification('Error: ' + data.error, 'error');
    }
  } catch (error) {
    console.error('Hard reset error:', error);
    showNotification('Error performing hard reset: ' + error.message, 'error');
  }
}

// Toggle file diff section (for multi-file commits)
function toggleFileDiff(header) {
  const content = header.nextElementSibling;
  const isExpanded = header.classList.contains('expanded');

  if (isExpanded) {
    header.classList.remove('expanded');
    header.classList.add('collapsed');
    content.style.display = 'none';
  } else {
    header.classList.remove('collapsed');
    header.classList.add('expanded');
    content.style.display = 'block';
  }
}


// Load initial view
loadTimeline();

function stepInput(id, step) {
  const input = document.getElementById(id);
  if (input) {
    const val = parseInt(input.value) || 0;
    const min = parseInt(input.min) || 1;
    const newVal = val + step;
    if (newVal >= min) {
      input.value = newVal;
      // Trigger change event if needed
      input.dispatchEvent(new Event('change'));
    }
  }
}

// ========================================
// HOLIDAY MODE FUNCTIONS
// ========================================

// Snowflake characters for variety
const SNOWFLAKE_CHARS = ['❄', '❅', '❆', '✻', '✼', '❉'];

// Number of snowflakes
const SNOWFLAKE_COUNT = 28;

// 10 Plaid Christmas Wrapping Paper Patterns (original style with color variations)
const PLAID_PATTERNS = [
  {
    name: 'Classic Red & Green',
    baseColor: '#8B1A1A', accentColor: 'rgba(0, 80, 0, 0.5)', threadColor: 'rgba(212, 175, 55, 0.25)'
  },
  {
    name: 'Forest Green & Red',
    baseColor: '#0D3D0D', accentColor: 'rgba(139, 26, 26, 0.5)', threadColor: 'rgba(212, 175, 55, 0.25)'
  },
  {
    name: 'Royal Blue & Gold',
    baseColor: '#0D47A1', accentColor: 'rgba(212, 175, 55, 0.4)', threadColor: 'rgba(255, 255, 255, 0.2)'
  },
  {
    name: 'Burgundy & Gold',
    baseColor: '#4A0E0E', accentColor: 'rgba(212, 175, 55, 0.4)', threadColor: 'rgba(255, 255, 255, 0.15)'
  },
  {
    name: 'Winter Navy',
    baseColor: '#1A237E', accentColor: 'rgba(255, 255, 255, 0.3)', threadColor: 'rgba(100, 149, 237, 0.3)'
  },
  {
    name: 'Holly Berry',
    baseColor: '#1B5E20', accentColor: 'rgba(200, 40, 40, 0.5)', threadColor: 'rgba(255, 255, 255, 0.2)'
  },
  {
    name: 'Silver Frost',
    baseColor: '#37474F', accentColor: 'rgba(255, 255, 255, 0.25)', threadColor: 'rgba(100, 200, 255, 0.2)'
  },
  {
    name: 'Cranberry',
    baseColor: '#880E4F', accentColor: 'rgba(255, 255, 255, 0.25)', threadColor: 'rgba(255, 182, 193, 0.3)'
  },
  {
    name: 'Gold Luxe',
    baseColor: '#8B6914', accentColor: 'rgba(139, 26, 26, 0.4)', threadColor: 'rgba(255, 255, 255, 0.2)'
  },
  {
    name: 'Purple Velvet',
    baseColor: '#4A148C', accentColor: 'rgba(212, 175, 55, 0.35)', threadColor: 'rgba(255, 255, 255, 0.2)'
  }
];

// Generate plaid pattern from color scheme
function generatePlaidPattern(pattern, size, angle, intensity) {
  const { baseColor, accentColor, threadColor } = pattern;
  // intensity 0 = solid color, 100 = full gradient
  const gradientStrength = (intensity || 50) / 100 * 30; // max 30% lighten/darken
  return `
    repeating-linear-gradient(
      0deg,
      transparent 0px,
      transparent ${size}px,
      ${accentColor} ${size}px,
      ${accentColor} ${size + 4}px,
      transparent ${size + 4}px,
      transparent ${size * 2}px,
      ${threadColor} ${size * 2}px,
      ${threadColor} ${size * 2 + 2}px,
      transparent ${size * 2 + 2}px
    ),
    repeating-linear-gradient(
      90deg,
      transparent 0px,
      transparent ${size}px,
      ${accentColor} ${size}px,
      ${accentColor} ${size + 4}px,
      transparent ${size + 4}px,
      transparent ${size * 2}px,
      ${threadColor} ${size * 2}px,
      ${threadColor} ${size * 2 + 2}px,
      transparent ${size * 2 + 2}px
    ),
    linear-gradient(${angle}deg, ${baseColor} 0%, ${lightenColor(baseColor, gradientStrength)} 25%, ${baseColor} 50%, ${darkenColor(baseColor, gradientStrength)} 75%, ${baseColor} 100%)
  `;
}

// Helper to lighten a hex color
function lightenColor(hex, percent) {
  const num = parseInt(hex.replace('#', ''), 16);
  const amt = Math.round(2.55 * percent);
  const R = Math.min(255, (num >> 16) + amt);
  const G = Math.min(255, ((num >> 8) & 0x00FF) + amt);
  const B = Math.min(255, (num & 0x0000FF) + amt);
  return '#' + (0x1000000 + R * 0x10000 + G * 0x100 + B).toString(16).slice(1);
}

// Helper to darken a hex color
function darkenColor(hex, percent) {
  const num = parseInt(hex.replace('#', ''), 16);
  const amt = Math.round(2.55 * percent);
  const R = Math.max(0, (num >> 16) - amt);
  const G = Math.max(0, ((num >> 8) & 0x00FF) - amt);
  const B = Math.max(0, (num & 0x0000FF) - amt);
  return '#' + (0x1000000 + R * 0x10000 + G * 0x100 + B).toString(16).slice(1);
}

// Helper to blend two colors (0 = color1, 1 = color2)
function blendColors(color1, color2, ratio) {
  const c1 = parseInt(color1.replace('#', ''), 16);
  const c2 = parseInt(color2.replace('#', ''), 16);
  const R = Math.round((c1 >> 16) * (1 - ratio) + (c2 >> 16) * ratio);
  const G = Math.round(((c1 >> 8) & 0xFF) * (1 - ratio) + ((c2 >> 8) & 0xFF) * ratio);
  const B = Math.round((c1 & 0xFF) * (1 - ratio) + (c2 & 0xFF) * ratio);
  return '#' + (0x1000000 + R * 0x10000 + G * 0x100 + B).toString(16).slice(1);
}

// Holiday design settings
let holidayDesign = {
  currentPlaidIndex: parseInt(localStorage.getItem('holidayPlaidIndex')) || 1,
  ribbonWidth: parseInt(localStorage.getItem('holidayRibbonWidth')) || 19,
  ribbonStyle: parseInt(localStorage.getItem('holidayRibbonStyle')) || 4,
  ribbon3D: parseInt(localStorage.getItem('holidayRibbon3D')) || 10,
  ribbonBrightness: localStorage.getItem('holidayRibbonBrightness') !== null ? parseInt(localStorage.getItem('holidayRibbonBrightness')) : -5,
  plaidSize: parseInt(localStorage.getItem('holidayPlaidSize')) || 24,
  paperGradientAngle: parseInt(localStorage.getItem('holidayPaperGradientAngle')) || 177,
  paperGradientIntensity: parseInt(localStorage.getItem('holidayPaperGradientIntensity')) || 30,
  paperShine: parseInt(localStorage.getItem('holidayPaperShine')) || 4,
  paperShineIntensity: parseInt(localStorage.getItem('holidayPaperShineIntensity')) || 10,
  bowSize: parseInt(localStorage.getItem('holidayBowSize')) || 139,
  bowOffset: parseInt(localStorage.getItem('holidayBowOffset')) || 53,
  bowShadow: parseInt(localStorage.getItem('holidayBowShadow')) || 6,
  bowShadowSpread: parseInt(localStorage.getItem('holidayBowShadowSpread')) || 3,
  bowStyle: parseInt(localStorage.getItem('holidayBowStyle')) || 1,
  borderEnabled: localStorage.getItem('holidayBorderEnabled') === 'true',
  borderWidth: parseInt(localStorage.getItem('holidayBorderWidth')) || 2,
  borderColor: localStorage.getItem('holidayBorderColor') || '#D4AF37'
};

// Ribbon gradient styles
const RIBBON_STYLES = [
  { name: 'Red Satin', colors: ['#5A0008', '#960011', '#B81520', '#960011', '#5A0008', '#400006'] },
  { name: 'Gold Satin', colors: ['#B8960C', '#D4AF37', '#F4CF47', '#D4AF37', '#B8960C', '#A07D00'] },
  { name: 'Green Velvet', colors: ['#0D3D0D', '#1B5E20', '#2E7D32', '#1B5E20', '#0D3D0D', '#052505'] },
  { name: 'Royal Blue', colors: ['#0D47A1', '#1565C0', '#1976D2', '#1565C0', '#0D47A1', '#052560'] },
  { name: 'Purple Silk', colors: ['#4A148C', '#6A1B9A', '#7B1FA2', '#6A1B9A', '#4A148C', '#38006b'] },
  { name: 'Silver Frost', colors: ['#455A64', '#607D8B', '#78909C', '#607D8B', '#455A64', '#37474F'] },
  { name: 'Rose Gold', colors: ['#8B5A5A', '#C78585', '#E0A0A0', '#C78585', '#8B5A5A', '#6B4040'] },
  { name: 'Candy Cane', colors: ['#D32F2F', '#FFFFFF', '#D32F2F', '#FFFFFF', '#D32F2F', '#B71C1C'] }
];

// Paper shine/gradient effects
const PAPER_SHINE_EFFECTS = [
  { name: 'None', css: '' },
  { name: 'Diagonal Shine', css: (i) => `linear-gradient(135deg, transparent 0%, rgba(255,255,255,${i / 100}) 25%, transparent 50%, rgba(255,255,255,${i / 200}) 75%, transparent 100%)` },
  { name: 'Top Glow', css: (i) => `linear-gradient(to bottom, rgba(255,255,255,${i / 100}) 0%, transparent 30%, transparent 100%)` },
  { name: 'Center Spotlight', css: (i) => `radial-gradient(ellipse at center, rgba(255,255,255,${i / 100}) 0%, transparent 50%)` },
  { name: 'Vignette', css: (i) => `radial-gradient(ellipse at center, transparent 30%, rgba(0,0,0,${i / 100}) 100%)` },
  { name: 'Shimmer', css: (i) => `repeating-linear-gradient(45deg, transparent 0px, transparent 10px, rgba(255,255,255,${i / 200}) 10px, rgba(255,255,255,${i / 200}) 11px)` },
  { name: 'Glossy', css: (i) => `linear-gradient(to bottom, rgba(255,255,255,${i / 80}) 0%, transparent 40%, transparent 60%, rgba(0,0,0,${i / 150}) 100%)` }
];

// Toggle Holiday Mode - onclick fires BEFORE checkbox changes, so invert logic
function toggleHolidayMode() {
  const checkbox = document.getElementById('holidayMode');
  // Since onclick fires before the checkbox value changes, we check the OPPOSITE
  const willBeEnabled = !checkbox.checked;

  if (willBeEnabled) {
    document.body.classList.add('holiday-mode');
    createSnowflakes();
    applyHolidayDesign();
    localStorage.setItem('holidayModeEnabled', 'true');
  } else {
    document.body.classList.remove('holiday-mode');
    clearSnowflakes();
    hideHolidayDesignPanel();
    localStorage.setItem('holidayModeEnabled', 'false');
  }
}

// Initialize Holiday Mode from localStorage
function initHolidayMode() {
  const saved = localStorage.getItem('holidayModeEnabled');
  const checkbox = document.getElementById('holidayMode');

  if (saved === 'true') {
    checkbox.checked = true;
    document.body.classList.add('holiday-mode');
    createSnowflakes();
    applyHolidayDesign();
    // showHolidayDesignPanel(); // Panel hidden by default now
  }
}

// Create snowflakes
function createSnowflakes() {
  const container = document.getElementById('snowContainer');
  if (!container) return;

  // Clear existing snowflakes first
  container.innerHTML = '';

  for (let i = 0; i < SNOWFLAKE_COUNT; i++) {
    const snowflake = document.createElement('div');
    snowflake.className = 'snowflake';

    // Random snowflake character
    snowflake.textContent = SNOWFLAKE_CHARS[Math.floor(Math.random() * SNOWFLAKE_CHARS.length)];

    // Random horizontal position
    snowflake.style.left = Math.random() * 100 + '%';

    // Random size (small variation for graceful look)
    const size = 8 + Math.random() * 8; // 8-16px
    snowflake.style.fontSize = size + 'px';

    // Random animation duration (slow, graceful: 10-18 seconds)
    const duration = 10 + Math.random() * 8;
    snowflake.style.animationDuration = duration + 's';

    // Staggered animation delay (so they don't all start at once)
    const delay = Math.random() * 15;
    snowflake.style.animationDelay = delay + 's';

    // Random animation type for variety
    const animations = ['snowfall', 'snowfall-alt1', 'snowfall-alt2'];
    snowflake.style.animationName = animations[Math.floor(Math.random() * animations.length)];

    // Slight opacity variation
    snowflake.style.opacity = 0.6 + Math.random() * 0.4;

    container.appendChild(snowflake);
  }
}

// Clear snowflakes
function clearSnowflakes() {
  const container = document.getElementById('snowContainer');
  if (container) {
    container.innerHTML = '';
  }
}

// Show holiday design adjustment panel
function showHolidayDesignPanel() {
  // Remove existing panel if any
  hideHolidayDesignPanel();

  const currentPattern = PLAID_PATTERNS[holidayDesign.currentPlaidIndex];

  const panel = document.createElement('div');
  panel.id = 'holidayDesignPanel';
  panel.innerHTML = `
    <div class="holiday-panel-header">
      <span>🎁 Present Designer</span>
      <button onclick="hideHolidayDesignPanel()" style="background:none;border:none;color:white;font-size:18px;cursor:pointer;">×</button>
    </div>
    <div class="holiday-panel-content" style="max-height: 70vh; overflow-y: auto;">
      
      <!-- Pattern Section -->
      <div class="holiday-section">
        <div class="holiday-section-title">🎨 Pattern</div>
        <div class="holiday-control" style="text-align:center; padding: 8px 0; background: rgba(255,255,255,0.05); border-radius: 8px;">
          <div style="font-size: 14px; color: #D4AF37; font-weight: 600;" id="currentPatternName">${currentPattern.name}</div>
        </div>
        <div class="holiday-control">
          <label>Pattern Scale: <span id="plaidSizeVal">${holidayDesign.plaidSize}px</span></label>
          <input type="range" min="15" max="60" value="${holidayDesign.plaidSize}" oninput="updateHolidayDesign('plaidSize', this.value)">
        </div>
      </div>
      
      <!-- Bow Section -->
      <div class="holiday-section">
        <div class="holiday-section-title">🎀 Bow</div>
        <div class="holiday-control">
          <label>Bow Style:</label>
          <div style="display: flex; gap: 8px; margin-top: 6px;">
            <button onclick="updateHolidayDesign('bowStyle', 1)" style="flex:1; padding: 8px; border-radius: 6px; border: 2px solid ${holidayDesign.bowStyle === 1 ? '#D4AF37' : '#444'}; background: ${holidayDesign.bowStyle === 1 ? 'rgba(212,175,55,0.2)' : '#333'}; color: white; cursor: pointer;">Bow 1</button>
            <button onclick="updateHolidayDesign('bowStyle', 2)" style="flex:1; padding: 8px; border-radius: 6px; border: 2px solid ${holidayDesign.bowStyle === 2 ? '#D4AF37' : '#444'}; background: ${holidayDesign.bowStyle === 2 ? 'rgba(212,175,55,0.2)' : '#333'}; color: white; cursor: pointer;">Bow 2</button>
            <button onclick="updateHolidayDesign('bowStyle', 3)" style="flex:1; padding: 8px; border-radius: 6px; border: 2px solid ${holidayDesign.bowStyle === 3 ? '#D4AF37' : '#444'}; background: ${holidayDesign.bowStyle === 3 ? 'rgba(212,175,55,0.2)' : '#333'}; color: white; cursor: pointer;">Bow 3</button>
          </div>
        </div>
        <div class="holiday-control">
          <label>Size: <span id="bowSizeVal">${holidayDesign.bowSize}px</span></label>
          <input type="range" min="40" max="180" value="${holidayDesign.bowSize}" oninput="updateHolidayDesign('bowSize', this.value)">
        </div>
        <div class="holiday-control">
          <label>Position: <span id="bowOffsetVal">${holidayDesign.bowOffset}px</span></label>
          <input type="range" min="-30" max="60" value="${holidayDesign.bowOffset}" oninput="updateHolidayDesign('bowOffset', this.value)">
        </div>
        <div class="holiday-control">
          <label>Shadow Blur: <span id="bowShadowVal">${holidayDesign.bowShadow}px</span></label>
          <input type="range" min="0" max="30" value="${holidayDesign.bowShadow}" oninput="updateHolidayDesign('bowShadow', this.value)">
        </div>
        <div class="holiday-control">
          <label>Shadow Spread: <span id="bowShadowSpreadVal">${holidayDesign.bowShadowSpread}px</span></label>
          <input type="range" min="0" max="40" value="${holidayDesign.bowShadowSpread}" oninput="updateHolidayDesign('bowShadowSpread', this.value)">
        </div>
      </div>
      
      <!-- Ribbon Section -->
      <div class="holiday-section">
        <div class="holiday-section-title">🎗️ Ribbon</div>
        <div class="holiday-control">
          <label>Style: <span style="color: #D4AF37;">${RIBBON_STYLES[holidayDesign.ribbonStyle - 1]?.name || 'Red Satin'}</span></label>
          <div style="display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px;">
            ${RIBBON_STYLES.map((style, i) => `
              <button onclick="updateHolidayDesign('ribbonStyle', ${i + 1})" 
                style="width: 28px; height: 28px; border-radius: 4px; border: 2px solid ${holidayDesign.ribbonStyle === i + 1 ? 'white' : 'transparent'}; 
                background: linear-gradient(to right, ${style.colors[0]}, ${style.colors[2]}, ${style.colors[4]}); cursor: pointer;" 
                title="${style.name}"></button>
            `).join('')}
          </div>
        </div>
        <div class="holiday-control">
          <label>Width: <span id="ribbonWidthVal">${holidayDesign.ribbonWidth}px</span></label>
          <input type="range" min="10" max="40" value="${holidayDesign.ribbonWidth}" oninput="updateHolidayDesign('ribbonWidth', this.value)">
        </div>
        <div class="holiday-control">
          <label>3D Effect: <span id="ribbon3DVal">${holidayDesign.ribbon3D}%</span></label>
          <input type="range" min="0" max="100" value="${holidayDesign.ribbon3D}" oninput="updateHolidayDesign('ribbon3D', this.value)">
        </div>
        <div class="holiday-control">
          <label>Brightness: <span id="ribbonBrightnessVal">${holidayDesign.ribbonBrightness}%</span></label>
          <input type="range" min="-50" max="50" value="${holidayDesign.ribbonBrightness}" oninput="updateHolidayDesign('ribbonBrightness', this.value)">
        </div>
      </div>
      
      <!-- Paper Shine Section -->
      <div class="holiday-section">
        <div class="holiday-section-title">✨ Paper Effect</div>
        <div class="holiday-control">
          <label>Gradient Angle: <span id="paperGradientAngleVal">${holidayDesign.paperGradientAngle}°</span></label>
          <input type="range" min="0" max="360" value="${holidayDesign.paperGradientAngle}" oninput="updateHolidayDesign('paperGradientAngle', this.value)">
        </div>
        <div class="holiday-control">
          <label>Gradient Intensity: <span id="paperGradientIntensityVal">${holidayDesign.paperGradientIntensity}%</span></label>
          <input type="range" min="0" max="100" value="${holidayDesign.paperGradientIntensity}" oninput="updateHolidayDesign('paperGradientIntensity', this.value)">
        </div>
        <div class="holiday-control">
          <label>Effect: <span style="color: #D4AF37;">${PAPER_SHINE_EFFECTS[holidayDesign.paperShine]?.name || 'None'}</span></label>
          <div style="display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px;">
            ${PAPER_SHINE_EFFECTS.map((effect, i) => `
              <button onclick="updateHolidayDesign('paperShine', ${i})" 
                style="padding: 4px 8px; border-radius: 4px; border: 2px solid ${holidayDesign.paperShine === i ? '#D4AF37' : '#444'}; 
                background: ${holidayDesign.paperShine === i ? 'rgba(212,175,55,0.2)' : '#333'}; color: white; cursor: pointer; font-size: 10px;" 
                title="${effect.name}">${effect.name}</button>
            `).join('')}
          </div>
        </div>
        <div class="holiday-control">
          <label>Intensity: <span id="paperShineIntensityVal">${holidayDesign.paperShineIntensity}%</span></label>
          <input type="range" min="10" max="80" value="${holidayDesign.paperShineIntensity}" oninput="updateHolidayDesign('paperShineIntensity', this.value)">
        </div>
      </div>
      
      <!-- Border Section -->
      <div class="holiday-section">
        <div class="holiday-section-title">📦 Border</div>
        <div class="holiday-control" style="display: flex; justify-content: space-between; align-items: center;">
          <label style="margin-bottom: 0;">Show Border</label>
          <label class="toggle-switch-mini">
            <input type="checkbox" ${holidayDesign.borderEnabled ? 'checked' : ''} onchange="updateHolidayDesign('borderEnabled', this.checked)">
            <span class="toggle-slider-mini"></span>
          </label>
        </div>
        <div class="holiday-control">
          <label>Width: <span id="borderWidthVal">${holidayDesign.borderWidth}px</span></label>
          <input type="range" min="1" max="8" value="${holidayDesign.borderWidth}" oninput="updateHolidayDesign('borderWidth', this.value)">
        </div>
        <div class="holiday-control">
          <label>Color:</label>
          <div style="display: flex; gap: 6px; margin-top: 6px;">
            <button onclick="updateHolidayDesign('borderColor', '#D4AF37')" style="width:28px; height:28px; border-radius:50%; border: 2px solid ${holidayDesign.borderColor === '#D4AF37' ? 'white' : 'transparent'}; background: #D4AF37; cursor:pointer;" title="Gold"></button>
            <button onclick="updateHolidayDesign('borderColor', '#960011')" style="width:28px; height:28px; border-radius:50%; border: 2px solid ${holidayDesign.borderColor === '#960011' ? 'white' : 'transparent'}; background: #960011; cursor:pointer;" title="Red"></button>
            <button onclick="updateHolidayDesign('borderColor', '#1B5E20')" style="width:28px; height:28px; border-radius:50%; border: 2px solid ${holidayDesign.borderColor === '#1B5E20' ? 'white' : 'transparent'}; background: #1B5E20; cursor:pointer;" title="Green"></button>
            <button onclick="updateHolidayDesign('borderColor', '#FFFFFF')" style="width:28px; height:28px; border-radius:50%; border: 2px solid ${holidayDesign.borderColor === '#FFFFFF' ? '#D4AF37' : '#666'}; background: #FFFFFF; cursor:pointer;" title="White"></button>
            <button onclick="updateHolidayDesign('borderColor', '#000000')" style="width:28px; height:28px; border-radius:50%; border: 2px solid ${holidayDesign.borderColor === '#000000' ? 'white' : '#666'}; background: #000000; cursor:pointer;" title="Black"></button>
          </div>
        </div>
      </div>
      
    </div>
  `;
  document.body.appendChild(panel);
}

// Hide holiday design panel
function hideHolidayDesignPanel() {
  const panel = document.getElementById('holidayDesignPanel');
  if (panel) {
    panel.remove();
  }
}

// Update holiday design setting
function updateHolidayDesign(setting, value) {
  // Handle different value types
  if (setting === 'borderEnabled') {
    holidayDesign[setting] = value === true || value === 'true';
  } else if (setting === 'borderColor') {
    holidayDesign[setting] = value;
  } else {
    holidayDesign[setting] = parseInt(value);
  }

  // Update display value if it exists
  const valSpan = document.getElementById(setting + 'Val');
  if (valSpan && typeof value !== 'boolean') {
    valSpan.textContent = value + (setting !== 'borderColor' ? 'px' : '');
  }

  // Save to localStorage
  localStorage.setItem('holiday' + setting.charAt(0).toUpperCase() + setting.slice(1), value);

  // Refresh panel for certain settings to update button states
  if (setting === 'bowStyle' || setting === 'borderColor' || setting === 'borderEnabled' || setting === 'ribbonStyle' || setting === 'paperShine') {
    showHolidayDesignPanel();
  }

  // Apply changes
  applyHolidayDesign();
}

// Apply holiday design CSS dynamically
function applyHolidayDesign() {
  let styleEl = document.getElementById('holidayDynamicStyle');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'holidayDynamicStyle';
    document.head.appendChild(styleEl);
  }

  const { currentPlaidIndex, ribbonWidth, ribbonStyle, ribbon3D, ribbonBrightness = 0, plaidSize, paperGradientAngle, paperGradientIntensity, paperShine, paperShineIntensity, bowSize, bowOffset, bowShadow, bowShadowSpread, bowStyle, borderEnabled, borderWidth, borderColor } = holidayDesign;

  // Get current plaid pattern
  const pattern = PLAID_PATTERNS[currentPlaidIndex];
  const wrapBg = generatePlaidPattern(pattern, plaidSize, paperGradientAngle, paperGradientIntensity);

  // Get ribbon colors with 3D effect applied
  const ribbon = RIBBON_STYLES[ribbonStyle - 1] || RIBBON_STYLES[0];

  // Apply brightness to base colors
  const baseColors = ribbon.colors.map(color => {
    if (ribbonBrightness > 0) return lightenColor(color, ribbonBrightness);
    if (ribbonBrightness < 0) return darkenColor(color, Math.abs(ribbonBrightness));
    return color;
  });

  const [r0, r1, r2, r3, r4, r5] = baseColors;
  // ribbon3D 0% = flat (all same color), 100% = full gradient
  const effect3D = ribbon3D / 100;
  // Blend colors based on 3D effect (when 0%, all look like r1)
  const rb0 = effect3D < 0.5 ? blendColors(r1, r0, effect3D * 2) : r0;
  const rb2 = effect3D < 0.5 ? blendColors(r1, r2, effect3D * 2) : r2;
  const rb5 = effect3D < 0.5 ? blendColors(r1, r5, effect3D * 2) : r5;

  // Get paper shine effect
  const shineEffect = PAPER_SHINE_EFFECTS[paperShine];
  const shineCss = shineEffect && shineEffect.css ? (typeof shineEffect.css === 'function' ? shineEffect.css(paperShineIntensity) + ',' : '') : '';

  // Bow image selection
  const bowImage = bowStyle === 3 ? 'images/holiday_bow_3.png' : bowStyle === 2 ? 'images/holiday_bow_2.png' : 'images/holiday_bow.png';

  // Border style
  const borderStyle = borderEnabled ? `${borderWidth}px solid ${borderColor}` : 'none';

  styleEl.textContent = `
    /* Dynamic Holiday Styles */
    body.holiday-mode .header {
      background: 
        /* Paper shine effect */
        ${shineCss}
        /* Horizontal ribbon */
        linear-gradient(
          to bottom,
          transparent calc(50% - ${ribbonWidth / 2}px),
          ${rb0} calc(50% - ${ribbonWidth / 2}px),
          ${r1} calc(50% - ${ribbonWidth / 2 - 2}px),
          ${rb2} calc(50% - 2px),
          ${r1} 50%,
          ${rb2} calc(50% + 2px),
          ${r1} calc(50% + ${ribbonWidth / 2 - 2}px),
          ${rb0} calc(50% + ${ribbonWidth / 2}px),
          transparent calc(50% + ${ribbonWidth / 2}px)
        ),
        ${wrapBg};
      /* cursor: pointer; removed */
      position: relative;
      border: ${borderStyle} !important;
    }
    
    /* Active removed */
    
    /* Vertical ribbon */
    body.holiday-mode .header::before {
      width: ${ribbonWidth}px;
      background: linear-gradient(
        to right,
        ${rb0} 0%,
        ${r1} 15%,
        ${rb2} 40%,
        ${r1} 60%,
        ${rb0} 85%,
        ${rb5} 100%
      );
    }
    
    /* Bow */
    body.holiday-mode .header::after {
      content: '';
      position: absolute;
      top: calc(-${bowSize * 0.35}px + ${bowOffset}px);
      left: 50%;
      transform: translateX(-50%);
      width: ${bowSize}px;
      height: ${bowSize}px;
      background-image: url('${bowImage}');
      background-size: contain;
      background-repeat: no-repeat;
      background-position: center;
      pointer-events: none;
      z-index: 10;
      filter: drop-shadow(0 ${bowShadow}px ${bowShadowSpread}px rgba(0, 0, 0, 0.5));
    }
    
    
    /* Holiday Design Panel Styles */
    #holidayDesignPanel {
      position: fixed;
      top: 20px;
      right: 20px;
      width: 280px;
      background: linear-gradient(135deg, rgba(30,30,30,0.98) 0%, rgba(20,20,20,0.98) 100%);
      border: 1px solid rgba(212, 175, 55, 0.5);
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4), 0 0 20px rgba(212, 175, 55, 0.2);
      z-index: 10000;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      overflow: hidden;
    }
    
    .holiday-panel-header {
      background: linear-gradient(90deg, #8B1A1A 0%, #6B0F0F 100%);
      color: white;
      padding: 12px 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-weight: 600;
      font-size: 14px;
    }
    
    .holiday-panel-content {
      padding: 16px;
    }
    
    .holiday-control {
      margin-bottom: 16px;
    }
    
    .holiday-control:last-child {
      margin-bottom: 0;
    }
    
    .holiday-control label {
      display: block;
      color: #ccc;
      font-size: 12px;
      margin-bottom: 6px;
    }
    
    .holiday-control label span {
      color: #D4AF37;
      font-weight: 600;
    }
    
    .holiday-control input[type="range"] {
      width: 100%;
      height: 6px;
      border-radius: 3px;
      background: #333;
      outline: none;
      -webkit-appearance: none;
    }
    
    .holiday-control input[type="range"]::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: linear-gradient(135deg, #D4AF37 0%, #B8960C 100%);
      cursor: pointer;
      box-shadow: 0 2px 6px rgba(0,0,0,0.3);
    }
    
    .holiday-control select {
      width: 100%;
      padding: 8px 12px;
      background: #333;
      border: 1px solid #555;
      border-radius: 6px;
      color: #fff;
      font-size: 13px;
      cursor: pointer;
    }
    
    .holiday-control select:focus {
      outline: none;
      border-color: #D4AF37;
    }
    
    .holiday-section {
      margin-bottom: 20px;
      padding-bottom: 16px;
      border-bottom: 1px solid rgba(255,255,255,0.1);
    }
    
    .holiday-section:last-child {
      margin-bottom: 0;
      padding-bottom: 0;
      border-bottom: none;
    }
    
    .holiday-section-title {
      color: #D4AF37;
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    
    .toggle-switch-mini {
      position: relative;
      display: inline-block;
      width: 40px;
      height: 22px;
    }
    
    .toggle-switch-mini input {
      opacity: 0;
      width: 0;
      height: 0;
    }
    
    .toggle-slider-mini {
      position: absolute;
      cursor: pointer;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background-color: #333;
      transition: .3s;
      border-radius: 22px;
    }
    
    .toggle-slider-mini:before {
      position: absolute;
      content: "";
      height: 16px;
      width: 16px;
      left: 3px;
      bottom: 3px;
      background-color: white;
      transition: .3s;
      border-radius: 50%;
    }
    
    .toggle-switch-mini input:checked + .toggle-slider-mini {
      background: linear-gradient(135deg, #D4AF37 0%, #B8960C 100%);
    }
    
    .toggle-switch-mini input:checked + .toggle-slider-mini:before {
      transform: translateX(18px);
    }
  `;
}