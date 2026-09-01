// API endpoint is relative to the current page
const API = 'api';

// Helper to strip auth tokens from URLs for safe display
// Converts http://TOKEN@host:port/path to http://host:port/path
function stripTokenFromUrl(url) {
  if (!url) return url;
  return url.replace(/:\/\/[^@]+@/, '://');
}
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

const REPO_NAME_KEY = 'cloudRepoName';
const DEBOUNCE_TIME_KEY = 'debounceTime';
const DEBOUNCE_UNIT_KEY = 'debounceTimeUnit';

// Diff style management

let currentDiffStyle = localStorage.getItem('diffStyle') || 'style-2';
// Date format is now auto-detected via browser locale with dateStyle/timeStyle
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

// Cycle through diff styles
function cycleDiffStyle() {
  const currentIndex = diffStyleOptions.findIndex(s => s.id === currentDiffStyle);
  const nextIndex = (currentIndex + 1) % diffStyleOptions.length;
  const nextStyle = diffStyleOptions[nextIndex];

  currentDiffStyle = nextStyle.id;
  localStorage.setItem('diffStyle', currentDiffStyle);

  // Apply immediately if possible, or refresh view
  const diffShell = document.querySelector('.diff-viewer-shell');
  if (diffShell) {
    // Remove old style class
    diffStyleOptions.forEach(s => diffShell.classList.remove(s.id));
    // Add new style class
    diffShell.classList.add(currentDiffStyle);
  }

  // Update settings UI if open
  const styleSelect = document.getElementById('diffStyle');
  if (styleSelect) {
    styleSelect.value = currentDiffStyle;
  }

  // Show ephemeral notification
  showNotification(`Diff Style: ${nextStyle.name}`, 'info', 1500);
}

// Cross-browser clipboard helper (Safari doesn't support navigator.clipboard after async operations)
async function copyToClipboard(text) {
  // Try modern clipboard API first
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      // Fall through to fallback
    }
  }

  // Fallback for Safari and older browsers
  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.style.position = 'fixed';
  textArea.style.left = '-9999px';
  textArea.style.top = '-9999px';
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();

  try {
    const successful = document.execCommand('copy');
    document.body.removeChild(textArea);
    if (successful) {
      return true;
    }
    throw new Error('execCommand copy failed');
  } catch (err) {
    document.body.removeChild(textArea);
    throw err;
  }
}

// Diff view format management
let diffViewFormat = localStorage.getItem('diffViewFormat') || 'split';

// Diff mode management - 'shifted' shows what each version changed, 'standard' is normal
let diffMode = localStorage.getItem('diffMode') || 'shifted';

// Compare to Current mode - true = compare to current file, false = compare to parent commit (GitHub-style)
let compareToCurrent = localStorage.getItem('compareToCurrent') !== 'false'; // Default: true (ON)

// Arrow direction: false = new intuitive (◀ = older/back in time), true = legacy (◀ = newer)
let reverseArrowDirection = localStorage.getItem('reverseArrowDirection') === 'true'; // Default: false (new behavior)

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

        // Max commits
        document.getElementById('maxCommits').value = settings.maxCommits;
        localStorage.setItem('maxCommits', settings.maxCommits);

        // Manual mode (Internal: manualMode, UI: autoSave)
        const manualMode = settings.manualMode === true;
        document.getElementById('autoSave').checked = !manualMode;
        localStorage.setItem('manualMode', manualMode);

        // Legacy Arrow Direction
        if (settings.legacyArrowDirection !== undefined) {
          reverseArrowDirection = settings.legacyArrowDirection === true;
          const reverseArrowDirectionToggle = document.getElementById('reverseArrowDirection');
          if (reverseArrowDirectionToggle) {
            reverseArrowDirectionToggle.checked = reverseArrowDirection;
          }
          localStorage.setItem('reverseArrowDirection', reverseArrowDirection);
        }

        // Update UI state
        handleRetentionToggle();
        handleLimitHistoryToggle();
        handleAutoSaveToggle();

      }
    }
  } catch (error) {
    console.error('Error loading settings from server:', error);
  }
}

/**
 * Initialize the panel resizer
 */
function initResizer() {
  const resizer = document.getElementById('resizer');
  const leftSide = resizer?.previousElementSibling;

  if (!resizer || !leftSide) return;

  let x = 0;
  let w = 0;

  const onMouseMove = (e) => {
    const dx = e.clientX - x;
    const newWidth = ((w + dx) / resizer.parentNode.getBoundingClientRect().width) * 100;

    // Constraints
    if (newWidth > 15 && newWidth < 70) {
      leftSide.style.setProperty('width', `${newWidth}%`, 'important');
    }
  };

  const onMouseUp = () => {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    document.body.classList.remove('resizing');

    // Save to localStorage
    localStorage.setItem('panel-width', leftSide.style.width);

    // Remove the temporary head style if it still exists (it shouldn't)
    document.getElementById('resizer-init-style')?.remove();
  };

  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();

    // Remove the early-load style so inline styles can take over
    document.getElementById('resizer-init-style')?.remove();

    x = e.clientX;
    const scrollWidth = leftSide.getBoundingClientRect().width;
    w = scrollWidth;

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.classList.add('resizing');
  });
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

  // Initialize resizer
  initResizer();


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

  // Load saved colors or use defaults (Ocean palette - two blues)
  const savedPrimaryColor = localStorage.getItem('picassoPrimaryColor') || '#2193b0';
  const savedSecondaryColor = localStorage.getItem('picassoSecondaryColor') || '#6dd5ed';

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

  // Load arrow direction setting
  const reverseArrowDirectionToggle = document.getElementById('reverseArrowDirection');
  if (reverseArrowDirectionToggle) {
    reverseArrowDirectionToggle.checked = reverseArrowDirection;
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

  // Initialize Confetti Mode from localStorage
  initConfettiMode();

  // Initialize mobile interactions and gestures
  initMobileInteractions();

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

/**
 * Cycle through defined color palettes
 */
function cyclePicassoPalette() {
  const primaryInput = document.getElementById('picassoPrimaryColor');
  const secondaryInput = document.getElementById('picassoSecondaryColor');
  if (!primaryInput || !secondaryInput) return;

  const currentPrimary = primaryInput.value.toLowerCase();
  const currentSecondary = secondaryInput.value.toLowerCase();

  // Find current index
  let currentIndex = PICASSO_PALETTE.findIndex(p =>
    p.primary.toLowerCase() === currentPrimary &&
    p.secondary.toLowerCase() === currentSecondary
  );

  // Move to next
  const nextIndex = (currentIndex + 1) % PICASSO_PALETTE.length;
  const nextPalette = PICASSO_PALETTE[nextIndex];

  // Apply
  primaryInput.value = nextPalette.primary;
  secondaryInput.value = nextPalette.secondary;

  // Trigger input events manually to apply and save
  primaryInput.dispatchEvent(new Event('input'));
  secondaryInput.dispatchEvent(new Event('input'));

  // Update visual selection in settings if open
  updatePaletteSelection(nextPalette.primary, nextPalette.secondary);

  // Show notification
  showNotification(`Theme Palette: ${nextPalette.name}`, 'info', 1500);
}

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

function toggleReverseArrowDirection(isChecked) {
  reverseArrowDirection = isChecked;
  localStorage.setItem('reverseArrowDirection', isChecked);
  // Refresh current view so buttons re-render with correct direction/disabled state
  refreshCurrentView();

  // Save to server
  fetch(`${API}/runtime-settings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      legacyArrowDirection: isChecked
    })
  }).catch(err => console.error('Error saving legacyArrowDirection to server:', err));
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


// =====================================
// File Extensions Tag Input Functions
// =====================================

// Current extensions state (loaded from server)
let currentExtensions = { include: ['yaml', 'yml'], exclude: ['secrets.yaml'] };

function handleExtensionInput(event, type) {
  if (event.key === 'Enter') {
    event.preventDefault();
    const input = event.target;
    const value = input.value.trim().replace(/^\./, ''); // Remove leading dot

    if (value) {
      addExtensionTag(type, value);
      input.value = '';
    }
  }
}

function addExtensionTag(type, value) {
  // Don't add duplicates
  if (type === 'include' && currentExtensions.include.includes(value)) return;
  if (type === 'exclude' && currentExtensions.exclude.includes(value)) return;

  // Update state
  if (type === 'include') {
    currentExtensions.include.push(value);
  } else {
    currentExtensions.exclude.push(value);
  }

  // Re-render tags
  renderExtensionTags();
}

function removeExtensionTag(type, value) {
  if (type === 'include') {
    currentExtensions.include = currentExtensions.include.filter(v => v !== value);
  } else {
    currentExtensions.exclude = currentExtensions.exclude.filter(v => v !== value);
  }
  renderExtensionTags();
}

function renderExtensionTags() {
  // Render include tags
  const includeContainer = document.getElementById('includeExtensions');
  if (includeContainer) {
    const input = includeContainer.querySelector('input');
    includeContainer.innerHTML = '';
    currentExtensions.include.forEach(ext => {
      const tag = createTagElement('include', ext);
      includeContainer.appendChild(tag);
    });
    includeContainer.appendChild(input || createTagInput('include'));
  }

  // Render exclude tags
  const excludeContainer = document.getElementById('excludeExtensions');
  if (excludeContainer) {
    const input = excludeContainer.querySelector('input');
    excludeContainer.innerHTML = '';
    currentExtensions.exclude.forEach(file => {
      const tag = createTagElement('exclude', file);
      excludeContainer.appendChild(tag);
    });
    excludeContainer.appendChild(input || createTagInput('exclude'));
  }
}

function createTagElement(type, value) {
  const tag = document.createElement('span');
  tag.className = 'extension-tag';
  tag.style.cssText = `
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    background: var(--primary);
    color: white;
    border-radius: 12px;
    font-size: 13px;
  `;
  tag.innerHTML = `
    ${value}
    <span onclick="removeExtensionTag('${type}', '${value}')" style="cursor: pointer; opacity: 0.7; font-size: 14px;">&times;</span>
  `;
  return tag;
}

function createTagInput(type) {
  const input = document.createElement('input');
  input.type = 'text';
  input.id = type === 'include' ? 'includeExtensionInput' : 'excludeExtensionInput';
  input.placeholder = type === 'include' ? 'Add extension...' : 'Add file...';
  input.style.cssText = `
    flex: 1;
    min-width: 100px;
    border: none;
    background: transparent;
    color: var(--text-primary);
    font-size: 14px;
    outline: none;
  `;
  input.onkeydown = (e) => handleExtensionInput(e, type);
  return input;
}

function loadExtensionsFromSettings(settings) {
  if (settings.extensions) {
    currentExtensions = {
      include: settings.extensions.include || ['yaml', 'yml'],
      exclude: settings.extensions.exclude || ['secrets.yaml']
    };
  }
  renderExtensionTags();
}

async function loadExtensionsSettings() {
  try {
    const response = await fetch(`${API}/runtime-settings`);
    const data = await response.json();
    if (data.success && data.settings) {
      loadExtensionsFromSettings(data.settings);
    }
  } catch (error) {
    console.error('Failed to load extensions settings:', error);
    // Use defaults
    renderExtensionTags();
  }
}

// Settings modal functions
function openSettings() {
  const settingsModal = document.getElementById('settingsModal');
  if (settingsModal) settingsModal.classList.add('active');

  // Highlight settings tab in mobile tab bar
  document.querySelectorAll('.mobile-tab-item').forEach(t => t.classList.remove('active'));
  const mobileSettingsTab = document.getElementById('mobileSettingsTab');
  if (mobileSettingsTab) mobileSettingsTab.classList.add('active');

  // Load cloud sync settings when modal opens
  loadCloudSyncSettings();

  // Load extensions settings
  loadExtensionsSettings();

  // Initialize auto save checkbox
  const autoSaveCheckbox = document.getElementById('autoSave');
  if (autoSaveCheckbox) {
    autoSaveCheckbox.checked = localStorage.getItem('manualMode') !== 'true';
    handleAutoSaveToggle();
  }
}

function closeSettings() {
  const settingsModal = document.getElementById('settingsModal');
  if (settingsModal) settingsModal.classList.remove('active');

  // Restore current mode tab in mobile tab bar
  document.querySelectorAll('.mobile-tab-item').forEach(t => t.classList.remove('active'));
  const activeTab = document.getElementById(`mobile${currentMode.charAt(0).toUpperCase() + currentMode.slice(1)}Tab`);
  if (activeTab) activeTab.classList.add('active');
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
  const limitHistory = document.getElementById('limitHistory').checked;
  const maxCommits = parseInt(document.getElementById('maxCommits').value);
  const manualMode = !document.getElementById('autoSave').checked;

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
  localStorage.setItem('limitHistory', limitHistory);
  localStorage.setItem('maxCommits', maxCommits);
  localStorage.setItem('manualMode', manualMode);
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
        retentionUnit,
        limitHistory,
        maxCommits,
        manualMode,
        extensions: currentExtensions,
        legacyArrowDirection: reverseArrowDirection
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

  // Save cloud sync settings
  const cloudSaveSuccess = await saveCloudSyncSettings();

  // If cloud settings failed (e.g. validation error), don't close modal
  if (cloudSaveSuccess === false) {
    return;
  }

  // Re-render current view to apply changes immediately
  try {
    refreshCurrentView();
  } catch (e) {
    console.error('Error refreshing view:', e);
  }

  // Settings saved - close modal
  try {
    closeSettings();
  } catch (e) {
    console.error('Error closing settings modal:', e);
  }

  // Update UI state based on new settings
  try {
    handleRetentionToggle();
    handleLimitHistoryToggle();
    handleAutoSaveToggle();
  } catch (e) {
    console.error('Error updating UI state:', e);
  }
}

/**
 * Flush repository (git gc)
 */
function flushRepository() {
  console.log('[UI] flushRepository (open dynamic modal) called');
  
  // Create confirmation dialog (same pattern as Reset Timeline modal)
  const modalHTML = `
    <div class="modal-backdrop active" id="flush-confirm-modal" onclick="if(event.target === this) closeFlushConfirmDialog()">
      <div class="modal-content hard-reset-dialog">
        <h3 data-i18n="settings.flush_repository">${t('settings.flush_repository')}</h3>
        <p data-i18n="settings.flush_confirm">${t('settings.flush_confirm')}</p>
        <div class="modal-actions">
          <button class="btn btn-secondary" onclick="closeFlushConfirmDialog()" data-i18n="app.cancel">${t('app.cancel')}</button>
          <button class="btn restore" onclick="executeFlush()" data-i18n="settings.flush_repository">${t('settings.flush_repository')}</button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', modalHTML);
  console.log('[UI] Flush confirmation dialog created');
}

function closeFlushConfirmDialog() {
  const modal = document.getElementById('flush-confirm-modal');
  if (modal) {
    modal.remove();
  }
}

/**
 * Execute the actual flush operation
 */
async function executeFlush() {
  closeFlushConfirmDialog();
  
  const btn = document.getElementById('flushBtn');
  if (btn) {
    btn.disabled = true;
  }

  const notification = showNotification(t('settings.flushing'), 'info', 0);

  try {
    const response = await fetch(`${API}/git/flush`, { 
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await response.json();

    if (notification) notification.remove();

    if (data.success) {
      showNotification(t('settings.flush_success'), 'success', 3000);
    } else {
      showNotification(t('settings.flush_error') + ': ' + (data.error || 'Unknown error'), 'error', 5000);
    }
  } catch (error) {
    if (notification) notification.remove();
    console.error('[UI] Flush failed:', error);
    showNotification(t('settings.flush_error'), 'error', 5000);
  } finally {
    if (btn) {
      btn.disabled = false;
    }
  }
}

function handleRetentionToggle() {
  const historyRetention = document.getElementById('historyRetention');
  const retentionOptions = document.getElementById('retentionOptions');
  if (historyRetention && retentionOptions) {
    retentionOptions.style.display = historyRetention.checked ? 'block' : 'none';
  }
}

function handleLimitHistoryToggle() {
  const limitHistory = document.getElementById('limitHistory');
  const maxCommitsValueSection = document.getElementById('maxCommitsValueSection');
  if (limitHistory && maxCommitsValueSection) {
    maxCommitsValueSection.style.display = limitHistory.checked ? 'block' : 'none';
  }
}

function handleAutoSaveToggle() {
  const autoSave = document.getElementById('autoSave');
  const debounceTimeOptions = document.getElementById('debounceTimeOptions');
  const manualCommitBtn = document.getElementById('manualCommitBtn');

  if (autoSave) {
    if (debounceTimeOptions) {
      debounceTimeOptions.style.display = autoSave.checked ? 'block' : 'none';
    }
    if (manualCommitBtn) {
      manualCommitBtn.style.display = autoSave.checked ? 'none' : 'flex';
    }
  }
}

async function triggerManualCommit() {
  const btn = document.getElementById('manualCommitBtn');
  if (btn) btn.disabled = true;

  showNotification('Creating manual backup...', 'info', 2000);

  try {
    const response = await fetch(`${API}/git/commit-manual`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: 'Manual mode control'
      })
    });

    const data = await response.json();

    if (data.success) {
      if (data.committed) {
        showNotification('Backup created successfully', 'success', 3000);
        // Refresh the timeline
        if (currentMode === 'timeline') {
          refreshCurrentView();
        }
      } else {
        showNotification('No changes to backup', 'info', 3000);
      }
    } else {
      showNotification(`Failed to create backup: ${data.error}`, 'error', 5000);
    }
  } catch (error) {
    console.error('Manual commit error:', error);
    showNotification(`Error: ${error.message}`, 'error', 5000);
  } finally {
    if (btn) btn.disabled = false;
  }
}


// =====================================
// Cloud Sync Functions
// =====================================

function handleCloudSyncToggle(save = false) {
  const cloudSyncEnabled = document.getElementById('cloudSyncEnabled');
  const cloudSyncOptions = document.getElementById('cloudSyncOptions');

  if (cloudSyncEnabled && cloudSyncOptions) {
    cloudSyncOptions.style.display = cloudSyncEnabled.checked ? 'block' : 'none';
  }

  if (save) {
    saveCloudSyncSettings(true);
  }
}

async function loadCloudSyncSettings() {
  try {
    const response = await fetch(`${API}/cloud-sync/settings`);
    const data = await response.json();

    if (data.success) {
      console.log(data);
      const settings = data.settings;

      // Update UI elements
      const enabledCheckbox = document.getElementById('cloudSyncEnabled');
      if (enabledCheckbox) {
        enabledCheckbox.checked = settings.enabled;
        handleCloudSyncToggle();
      }

      // Determine provider from settings
      // If authProvider is github, or if remoteUrl is empty, default to github
      // If authProvider is generic, or if we have a remoteUrl and authProvider is strictly NOT github, default to custom
      const isGithub = settings.authProvider === 'github' || (!settings.authProvider && !settings.remoteUrl);

      const providerGithub = document.getElementById('cloudProviderGithub');
      const providerCustom = document.getElementById('cloudProviderCustom');

      if (providerGithub && providerCustom) {
        providerGithub.checked = isGithub;
        providerCustom.checked = !isGithub;
        // Trigger UI update
        if (typeof handleCloudProviderChange === 'function') {
          handleCloudProviderChange();
        }
      }

      const remoteUrlInput = document.getElementById('cloudRemoteUrl');
      if (remoteUrlInput) {
        remoteUrlInput.value = settings.remoteUrl || '';
      }

      const pushFrequencySelect = document.getElementById('cloudPushFrequency');
      if (pushFrequencySelect) {
        pushFrequencySelect.value = settings.pushFrequency || 'manual';
      }

      const includeSecretsCheckbox = document.getElementById('cloudIncludeSecrets');
      if (includeSecretsCheckbox) {
        includeSecretsCheckbox.checked = settings.includeSecrets === true;
      }

      const ignoreSslCheckbox = document.getElementById('cloudIgnoreSslErrors');
      if (ignoreSslCheckbox) {
        ignoreSslCheckbox.checked = settings.ignoreSslErrors === true;
      }

      // Hide secrets toggle if secrets.yaml is already in exclude_files (making toggle irrelevant)
      const secretsToggleContainer = document.getElementById('secretsToggleContainer');
      if (secretsToggleContainer) {
        // Check if secrets.yaml is excluded via extensions config
        try {
          const extResponse = await fetch(`${API}/runtime-settings`);
          const extData = await extResponse.json();
          const excludeFiles = extData?.settings?.extensions?.exclude || [];
          const secretsExcluded = excludeFiles.includes('secrets.yaml');
          secretsToggleContainer.style.display = secretsExcluded ? 'none' : 'block';
        } catch (e) {
          // Default to showing toggle on error
          secretsToggleContainer.style.display = 'block';
        }
      }

      // Update status
      updateCloudSyncStatus(settings);

      // Load GitHub user info if connected/relevant
      if (isGithub) {
        loadGitHubUser();
      } else {
        // For custom provider, show connected state if we have a custom URL
        if (settings.customRemoteUrl) {
          const customNotConnected = document.getElementById('customNotConnected');
          const customConnected = document.getElementById('customConnected');
          const repoLink = document.getElementById('customRepoLink');

          if (customNotConnected && customConnected) {
            customNotConnected.style.display = 'none';
            customConnected.style.display = 'block';
            const customAccountLabel = document.getElementById('customAccountLabel');
            if (customAccountLabel) customAccountLabel.style.display = 'block';

            if (repoLink) {
              const cleanUrl = stripTokenFromUrl(settings.customRemoteUrl);
              const parts = cleanUrl.replace(/\.git$/, '').split('/').filter(p => p);
              // Show User/Owner (2nd to last part) or fallback to Repo Name (last part)
              const repoName = parts.length >= 2 ? parts[parts.length - 2] : (parts.pop() || 'Repository');
              repoLink.textContent = repoName;
              repoLink.href = cleanUrl.replace(/\.git$/, '');

              // Try to load avatar
              updateCustomRepoAvatar(settings.customRemoteUrl);
            }
          }
        }
      }
    }
  } catch (error) {
    console.error('Failed to load cloud sync settings:', error);
  }
}

async function updateCustomRepoAvatar(remoteUrl) {
  const avatarImg = document.getElementById('customRepoAvatar');
  const iconSvg = document.getElementById('customRepoIcon');
  const repoLink = document.getElementById('customRepoLink');
  if (!avatarImg || !iconSvg || !remoteUrl) return;

  // Reset to icon initially (or keep current if reloading)
  // avatarImg.style.display = 'none';
  // iconSvg.style.display = 'block';

  try {
    // Call backend API to get avatar URL and user info (handles Gitea API auth)
    const response = await fetch(`/api/cloud-sync/avatar?remoteUrl=${encodeURIComponent(remoteUrl)}`);
    const data = await response.json();

    if (data.success) {
      console.log('[Custom] Got user info:', data);

      // Update account label based on detected provider
      const customAccountLabel = document.getElementById('customAccountLabel');
      if (customAccountLabel) {
        const labelSpan = customAccountLabel.querySelector('span');
        if (labelSpan && data.provider) {
          const providerNames = {
            'gitea': 'Gitea Account',
            'gitlab': 'GitLab Account',
            'custom': 'Custom Account'
          };
          labelSpan.textContent = providerNames[data.provider] || 'Custom Account';
        }
      }

      // Update display name if available
      if (repoLink && data.fullName) {
        repoLink.textContent = data.fullName;
      }

      // Update avatar if available
      if (data.avatarUrl) {
        avatarImg.onload = () => {
          avatarImg.style.display = 'block';
          iconSvg.style.display = 'none';
        };

        avatarImg.onerror = () => {
          console.warn('Avatar image failed to load');
          avatarImg.style.display = 'none';
          iconSvg.style.display = 'block';
        };

        avatarImg.src = data.avatarUrl;
      } else {
        avatarImg.style.display = 'none';
        iconSvg.style.display = 'block';
      }
    } else {
      console.log('[Custom] No user info found via API, falling back to defaults');
      avatarImg.style.display = 'none';
      iconSvg.style.display = 'block';
    }
  } catch (e) {
    console.warn('[Custom] Error fetching user info:', e);
    avatarImg.style.display = 'none';
    iconSvg.style.display = 'block';
  }
}

async function saveCloudSyncSettings(silent = false) {
  const cloudSyncEnabled = document.getElementById('cloudSyncEnabled');
  const enabled = cloudSyncEnabled ? cloudSyncEnabled.checked : false;
  const providerGithub = document.getElementById('cloudProviderGithub');
  const isGithub = providerGithub ? providerGithub.checked : true;
  let remoteUrl = '';
  let authProvider = isGithub ? 'github' : 'generic';

  const inputUrlElement = document.getElementById('cloudRemoteUrl');
  const inputUrl = inputUrlElement ? inputUrlElement.value.trim() : '';

  if (isGithub) {
    // For GitHub mode, DON'T send the hidden input URL - it might be a Custom URL
    // Let the backend use the stored GitHub URL instead
    // Only exception: if the hidden input has a github.com URL, we can send it
    if (inputUrl.includes('github.com')) {
      remoteUrl = inputUrl;
    }
  } else {
    // Custom mode - use the URL from the input
    remoteUrl = inputUrl;
  }

  const pushFrequencyElement = document.getElementById('cloudPushFrequency');
  const pushFrequency = pushFrequencyElement ? pushFrequencyElement.value : 'manual';
  const includeSecrets = document.getElementById('cloudIncludeSecrets')?.checked ?? false;
  const ignoreSslErrors = document.getElementById('cloudIgnoreSslErrors')?.checked ?? false;

  try {
    const payload = {
      enabled,
      remoteUrl,
      pushFrequency,
      includeSecrets,
      ignoreSslErrors,
      authProvider
    };
    console.log('[saveCloudSyncSettings] Sending payload:', payload);

    const response = await fetch(`${API}/cloud-sync/settings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    console.log('[saveCloudSyncSettings] Response:', data);

    if (data.success) {
      if (!silent && false) showNotification('Settings saved', 'success');
      // Don't reload settings here - let the caller handle any needed refreshes
      return true;
    } else {
      console.error('[saveCloudSyncSettings] Error from server:', data.error);
      if (!silent) {
        // showNotification('Error saving settings: ' + data.error, 'error');
      }
      return false;
    }
  } catch (error) {
    console.error('[saveCloudSyncSettings] Exception:', error);
    // showNotification('Error saving settings', 'error');
    return false;
  }
}

async function testCloudConnection() {
  const remoteUrlInput = document.getElementById('cloudRemoteUrl');
  const remoteUrl = remoteUrlInput ? remoteUrlInput.value.trim() : '';

  // Backend now handles fallback to stored URL, so we can proceed even if empty here.
  // Only show error if we confirm backend has no URL via API response.

  showNotification('Testing connection...', 'info', 2000);

  try {
    // Pass empty authToken if hidden input doesn't exist (it doesn't anymore)
    // Backend will use stored token.
    const response = await fetch(`${API}/cloud-sync/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        remoteUrl,
        ignoreSslErrors: document.getElementById('cloudIgnoreSslErrors').checked
      })
    });

    const data = await response.json();

    if (data.success) {
      showNotification('Connection successful!', 'success', 3000);
    } else {
      showNotification(`Connection failed: ${data.error}`, 'error', 5000);
    }
  } catch (error) {
    console.error('Test connection error:', error);
    showNotification(`Error: ${error.message}`, 'error', 5000);
  }
}

// Test custom repo connection and show connected state
async function testCustomConnection() {
  const remoteUrlInput = document.getElementById('cloudRemoteUrl');
  const remoteUrl = remoteUrlInput ? remoteUrlInput.value.trim() : '';

  if (!remoteUrl) {
    showNotification('Please enter a remote URL', 'error', 3000);
    return;
  }

  showNotification('Testing connection...', 'info', 2000);

  try {
    // First save the URL
    await saveCloudSyncSettings(true);

    // Then test the connection
    const response = await fetch(`${API}/cloud-sync/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        remoteUrl,
        ignoreSslErrors: document.getElementById('cloudIgnoreSslErrors').checked
      })
    });

    const data = await response.json();

    if (data.success) {
      showNotification('Connection successful!', 'success', 3000);

      // Show connected state
      document.getElementById('customNotConnected').style.display = 'none';
      document.getElementById('customConnected').style.display = 'block';
      const customAccountLabel = document.getElementById('customAccountLabel');
      if (customAccountLabel) customAccountLabel.style.display = 'block';

      // Update the repo link
      const repoLink = document.getElementById('customRepoLink');
      if (repoLink) {
        // Strip token and extract repo name from URL
        const cleanUrl = stripTokenFromUrl(remoteUrl);
        const parts = cleanUrl.replace(/\.git$/, '').split('/').filter(p => p);
        // Show User/Owner (2nd to last part) or fallback to Repo Name (last part)
        const repoName = parts.length >= 2 ? parts[parts.length - 2] : (parts.pop() || 'Repository');
        repoLink.textContent = repoName;
        repoLink.href = cleanUrl.replace(/\.git$/, '');

        // Try to load avatar
        updateCustomRepoAvatar(remoteUrl);
      }
    } else {
      showNotification(`Connection failed: ${data.error}`, 'error', 5000);
    }
  } catch (error) {
    console.error('Test custom connection error:', error);
    showNotification(`Error: ${error.message}`, 'error', 5000);
  }
}

// Disconnect custom repo (show URL input again)
function disconnectCustom() {
  document.getElementById('customNotConnected').style.display = 'block';
  document.getElementById('customConnected').style.display = 'none';
  const customAccountLabel = document.getElementById('customAccountLabel');
  if (customAccountLabel) customAccountLabel.style.display = 'none';
  showNotification('Custom repo disconnected', 'info', 3000);
}

async function pushToCloudNow() {
  showNotification('Pushing to cloud...', 'info', 2000);

  // Save current settings first
  const saveSuccess = await saveCloudSyncSettings(true); // silent - don't show "Settings saved"

  if (saveSuccess === false) {
    return;
  }

  try {
    const response = await fetch(`${API}/cloud-sync/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: true })
    });

    const data = await response.json();

    if (data.success) {
      showNotification('Push successful!', 'success', 3000);
      loadCloudSyncSettings();
    } else {
      showNotification(`Push failed: ${data.error}`, 'error', 5000);
    }
  } catch (error) {
    console.error('Push error:', error);
    showNotification(`Push error: ${error.message}`, 'error', 5000);
  }
}

function updateCloudSyncStatus(settings) {
  const lastPushTime = document.getElementById('cloudLastPushTime');
  const lastPushStatus = document.getElementById('cloudLastPushStatus');

  if (!lastPushTime || !lastPushStatus) return;

  if (settings.lastPushTime) {
    const formatted = getFormattedDate(settings.lastPushTime);
    lastPushTime.textContent = formatted;

    if (settings.lastPushStatus === 'success') {
      lastPushStatus.textContent = '';
    } else if (settings.lastPushStatus === 'error') {
      lastPushStatus.textContent = ' ✗ ' + (settings.lastPushError || 'Error');
      lastPushStatus.style.color = 'var(--danger)';
    } else {
      lastPushStatus.textContent = '';
    }
  } else {
    lastPushTime.textContent = 'Never';
    lastPushStatus.textContent = '';
  }
}

// =====================================
// GitHub OAuth Device Flow
// =====================================


let isGitHubPolling = false;

async function connectGitHub() {
  // Stop any existing polling immediately
  if (isGitHubPolling) {
    isGitHubPolling = false;
    await new Promise(r => setTimeout(r, 500)); // Give it a moment to stop
  }

  const btn = document.getElementById('connectGithubBtn');
  if (btn) btn.disabled = true;

  try {
    // Show connecting state
    document.getElementById('githubNotConnected').style.display = 'none';
    document.getElementById('githubConnecting').style.display = 'block';
    document.getElementById('githubConnected').style.display = 'none';

    console.log('[Frontend] Initiating GitHub Device Flow...');

    // Initiate device flow
    const response = await fetch(`${API}/github/device-flow/initiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    const data = await response.json();

    if (!data.success) {
      showNotification(`GitHub auth failed: ${data.error}`, 'error', 5000);
      cancelGitHubConnect();
      return;
    }

    console.log('[Frontend] Device flow initiated. User code:', data.user_code);

    // Show the user code
    document.getElementById('githubUserCode').textContent = data.user_code;

    // Auto-copy to clipboard (with Safari fallback)
    // Don't auto-copy - user will tap the code to copy (works in Safari Web Apps)

    // Start polling for token
    isGitHubPolling = true;
    const pollIntervalMs = (data.interval || 5) * 1000;
    const maxAttempts = Math.ceil(data.expires_in / (data.interval || 5));
    let attempts = 0;

    console.log(`[Frontend] Starting poll loop. Interval: ${pollIntervalMs}ms`);

    const pollForToken = async () => {
      if (!isGitHubPolling) {
        console.log('[Frontend] Polling stopped by user or timeout.');
        return;
      }

      attempts++;
      if (attempts > maxAttempts) {
        console.log('[Frontend] Polling timed out.');
        showNotification('Authorization timed out', 'error', 5000);
        cancelGitHubConnect();
        return;
      }

      try {
        // console.log(`[Frontend] Polling attempt ${attempts}...`);
        const pollResponse = await fetch(`${API}/github/device-flow/poll`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ device_code: data.device_code })
        });

        const pollData = await pollResponse.json();

        if (pollData.success) {
          console.log('[Frontend] Token received!');
          isGitHubPolling = false;
          showNotification('GitHub connected! Creating repository...', 'success', 3000);

          // Create the repository automatically
          await createGitHubRepo();
          await loadGitHubUser();
          // Reload settings to ensure everything is in sync
          await loadCloudSyncSettings();
          return;
        }

        if (pollData.expired) {
          console.log('[Frontend] Code expired.');
          isGitHubPolling = false;
          showNotification('Code expired. Please try again.', 'error', 5000);
          cancelGitHubConnect();
          return;
        }

        if (pollData.denied) {
          console.log('[Frontend] Access denied.');
          isGitHubPolling = false;
          showNotification('Access denied', 'error', 5000);
          cancelGitHubConnect();
          return;
        }

        if (pollData.pending || pollData.slow_down) {
          // Expected states, continue polling
          const nextInterval = pollData.slow_down ? (pollIntervalMs + 5000) : pollIntervalMs;
          setTimeout(pollForToken, nextInterval);
        } else {
          // Unknown error? retry anyway?
          console.warn('[Frontend] Unknown poll state:', pollData);
          setTimeout(pollForToken, pollIntervalMs);
        }

      } catch (error) {
        console.error('[Frontend] Poll fetch error:', error);
        // Retry on network error
        setTimeout(pollForToken, pollIntervalMs);
      }
    };

    // Start the loop
    setTimeout(pollForToken, pollIntervalMs);

    // Open GitHub in new tab LAST to avoid blocking
    console.log('[Frontend] Opening GitHub URL...');
    window.open(data.verification_uri, '_blank');

  } catch (error) {
    console.error('GitHub connect error:', error);
    showNotification(`Error: ${error.message}`, 'error', 5000);
    cancelGitHubConnect();
  }
}

function cancelGitHubConnect() {
  isGitHubPolling = false;
  console.log('[Frontend] Cancelling GitHub connect.');

  const btn = document.getElementById('connectGithubBtn');
  if (btn) btn.disabled = false;

  document.getElementById('githubNotConnected').style.display = 'block';
  document.getElementById('githubConnecting').style.display = 'none';
  document.getElementById('githubConnected').style.display = 'none';
}

// Copy GitHub code on tap - works in Safari Web Apps since it's a direct user gesture
async function copyGitHubCode() {
  const codeElement = document.getElementById('githubUserCode');
  const code = codeElement?.textContent?.trim();

  if (!code) {
    showNotification('No code to copy', 'error', 2000);
    return;
  }

  try {
    await copyToClipboard(code);
    showNotification('Code copied! Paste into GitHub', 'success', 3000);
  } catch (err) {
    console.error('Copy failed:', err);
    showNotification('Copy failed - please select and copy manually', 'error', 4000);
  }
}

async function loadGitHubUser() {
  try {
    const response = await fetch(`${API}/github/user`);
    const data = await response.json();

    if (data.success && data.user) {
      document.getElementById('githubNotConnected').style.display = 'none';
      document.getElementById('githubConnecting').style.display = 'none';
      document.getElementById('githubConnected').style.display = 'block';

      // Hide the entire repo name section since we're already connected
      const repoNameSection = document.getElementById('repoNameSection');
      if (repoNameSection) repoNameSection.style.display = 'none';

      document.getElementById('githubAvatar').src = data.user.avatar_url;

      // Populate the repo link - shows username but links to repo
      const repoLink = document.getElementById('githubRepoLink');
      const remoteUrl = document.getElementById('cloudRemoteUrl')?.value;
      if (repoLink) {
        repoLink.textContent = data.user.name || data.user.login;
        let targetUrl = `https://github.com/${data.user.login}`;
        if (remoteUrl) {
          // Remove inline token credentials (e.g. https://token@github.com/...)
          const cleanUrl = remoteUrl.replace(/https?:\/\/[^@]+@/, 'https://').replace(/\.git$/, '');
          if (cleanUrl.startsWith('http')) {
            targetUrl = cleanUrl;
          }
        } else {
          const repoName = document.getElementById('cloudRepoName')?.value || 'VersionControlBackup';
          targetUrl = `https://github.com/${data.user.login}/${repoName}`;
        }
        repoLink.href = targetUrl;
      }
    } else {
      // Not connected - show repo name section
      document.getElementById('githubNotConnected').style.display = 'block';
      document.getElementById('githubConnecting').style.display = 'none';
      document.getElementById('githubConnected').style.display = 'none';
      const repoNameSection = document.getElementById('repoNameSection');
      if (repoNameSection) repoNameSection.style.display = 'block';
    }
  } catch (error) {
    console.error('Failed to load GitHub user:', error);
    document.getElementById('githubNotConnected').style.display = 'block';
    document.getElementById('githubConnecting').style.display = 'none';
    document.getElementById('githubConnected').style.display = 'none';
    const repoNameSection = document.getElementById('repoNameSection');
    if (repoNameSection) repoNameSection.style.display = 'block';
  }
}

async function disconnectGitHub() {
  try {
    const response = await fetch(`${API}/github/disconnect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    const data = await response.json();

    if (data.success) {
      showNotification('GitHub disconnected', 'info', 3000);
      document.getElementById('githubNotConnected').style.display = 'block';
      document.getElementById('githubConnecting').style.display = 'none';
      document.getElementById('githubConnected').style.display = 'none';
      // Show repo name section again
      const repoNameSection = document.getElementById('repoNameSection');
      if (repoNameSection) repoNameSection.style.display = 'block';
    }
  } catch (error) {
    console.error('Disconnect error:', error);
    showNotification(`Error: ${error.message}`, 'error', 5000);
  }
}

async function createGitHubRepo() {
  try {
    const repoName = document.getElementById('cloudRepoName')?.value?.trim() || 'VersionControlBackup';

    const response = await fetch(`${API}/github/create-repo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoName })
    });

    const data = await response.json();

    if (data.success) {
      // Show different message for new vs existing repo
      if (data.existing) {
        showNotification(`Using existing repository "${data.repo.name}"`, 'success', 3000);
      } else {
        showNotification(`Repository "${data.repo.name}" created!`, 'success', 3000);
      }

      // Update the hidden remote URL field
      const urlField = document.getElementById('cloudRemoteUrl');
      if (urlField) {
        urlField.value = data.repo.clone_url;
      }

      return data.repo;
    } else {
      showNotification(`Failed to create repo: ${data.error}`, 'error', 5000);
      return null;
    }
  } catch (error) {
    console.error('Create repo error:', error);
    showNotification(`Error: ${error.message}`, 'error', 5000);
    return null;
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
    return date.toLocaleString(undefined, { month: 'long' });
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

// Generic date formatter using browser/system locale defaults
function getFormattedDate(dateInput) {
  if (!dateInput) return '';
  const date = new Date(dateInput);

  // Using dateStyle and timeStyle allows the browser to pick the best format
  // based on the user's system locale (Short/Medium dates, 12h vs 24h time)
  // This is smarter than hardcoding unit components.
  try {
    return date.toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short'
    });
  } catch (e) {
    // Fallback for older browsers
    return date.toLocaleString();
  }
}

function formatDateForLabel(dateString) {
  return getFormattedDate(dateString);
}

// File path utilities
function toDisplayPath(repoPath, { leadingSlash = false } = {}) {
  if (!repoPath) return repoPath;
  const normalized = String(repoPath).replace(/\\/g, '/').replace(/^\/+/, '');
  const mirrorPrefix = '.havc_external/';

  if (normalized.startsWith(mirrorPrefix)) {
    const virtualPath = normalized.substring(mirrorPrefix.length);
    return leadingSlash ? `/${virtualPath}` : virtualPath;
  }

  return normalized;
}

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
    const displayPath = toDisplayPath(filePath);
    return filePath.toLowerCase().includes(query) || displayPath.toLowerCase().includes(query);
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
  navigateBackToMaster(false);
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

  // If 'deleted' is selected, load deleted items instead of sorting
  if (value === 'deleted') {
    if (currentMode === 'files') loadDeletedFiles();
    else if (currentMode === 'automations') loadDeletedAutomations();
    else if (currentMode === 'scripts') loadDeletedScripts();
    return;
  }

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

function navigateBackToMaster(smooth = true) {
  const mainContent = document.getElementById('mainContent');
  if (mainContent) {
    mainContent.classList.remove('mobile-detail-active');
  }
}

function navigateToDetail() {
  const mainContent = document.getElementById('mainContent');
  if (mainContent && window.innerWidth <= 768) {
    mainContent.classList.add('mobile-detail-active');
  }
}

function getRestoreButtonText() {
  return window.innerWidth <= 768 ? t('files.restore_button') : t('timeline.restore_commit');
}

function initMobileInteractions() {
  // Close modals on overlay backdrop click (if clicking outside modal body)
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        if (overlay.id === 'diffModal') closeModal();
        else if (overlay.id === 'restorePreviewModal') closeRestorePreview();
        else if (overlay.id === 'settingsModal') closeSettings();
        else overlay.classList.remove('active');
      }
    });
  });

  // Touch drag-down on sheet handle to close action sheet
  document.querySelectorAll('.sheet-drag-handle').forEach(handle => {
    let startY = 0;
    let currentY = 0;
    const modal = handle.closest('.modal');
    if (!modal) return;

    handle.addEventListener('touchstart', (e) => {
      startY = e.touches[0].clientY;
      currentY = startY;
    }, { passive: true });

    handle.addEventListener('touchmove', (e) => {
      currentY = e.touches[0].clientY;
      const deltaY = currentY - startY;
      if (deltaY > 0) {
        modal.style.transform = `translateY(${deltaY}px)`;
      }
    }, { passive: true });

    handle.addEventListener('touchend', () => {
      const deltaY = currentY - startY;
      modal.style.transform = '';
      if (deltaY > 60) {
        const overlay = modal.closest('.modal-overlay');
        if (overlay) {
          if (overlay.id === 'diffModal') closeModal();
          else if (overlay.id === 'restorePreviewModal') closeRestorePreview();
          else if (overlay.id === 'settingsModal') closeSettings();
          else overlay.classList.remove('active');
        }
      }
    });
  });
}

async function switchMode(mode) {
  currentMode = mode;
  currentSelection = null;

  // Close settings if open
  const settingsModal = document.getElementById('settingsModal');
  if (settingsModal && settingsModal.classList.contains('active')) {
    settingsModal.classList.remove('active');
  }

  // Reset mobile detail view back to master
  navigateBackToMaster(false);

  // Hide the floating button when switching modes
  hideFloatingConfirmRestoreButton();

  // Update desktop tabs
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  const desktopTab = document.getElementById(`${mode}Tab`);
  if (desktopTab) desktopTab.classList.add('active');

  // Update mobile bottom tab bar
  document.querySelectorAll('.mobile-tab-item').forEach(t => t.classList.remove('active'));
  const activeMobileTab = document.getElementById(`mobile${mode.charAt(0).toUpperCase() + mode.slice(1)}Tab`);
  if (activeMobileTab) activeMobileTab.classList.add('active');

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
    sortSelect.style.display = '';

    // Ensure valid sort state for this mode (prevent selecting removed option)
    if ((mode === 'automations' || mode === 'scripts') && sortState[mode] === 'recently_modified') {
      sortState[mode] = 'default';
      localStorage.setItem(`sort_${mode}`, 'default');
    }

    sortSelect.value = sortState[mode];
  } else {
    leftPanelActions.style.display = 'none';
    sortSelect.style.display = 'none';
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
      // Update UI with total count for debugging
      document.getElementById('leftPanelTitle').textContent = `${t('timeline.title')} (${allCommits.length})`;
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

      // Determine if expanded by default - ALL expanded by default now to avoid confusion
      const isExpanded = true;

      const collapsedClass = isExpanded ? '' : 'collapsed';
      const groupCollapsedClass = isExpanded ? '' : 'collapsed';

      html += `
            <div class="date-group ${groupCollapsedClass}">
              <div class="date-header ${collapsedClass}" onclick="toggleDateGroup('${bucket}')" id="header-${bucket}">
                ${displayName} (${groups[bucket].length})
              </div>
              <div class="date-content ${collapsedClass}" id="content-${bucket}">
          `;

      for (const commit of groups[bucket]) {
        const timeString = getFormattedDate(commit.date);

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

        // Apply toDisplayPath to strip .havc_external/ mirror prefix if present
        fileName = toDisplayPath(fileName, { leadingSlash: true });

        html += `
              <div class="commit" onclick="showCommit('${commit.hash}')" oncontextmenu="showTimelineContextMenu(event, '${commit.hash}')" id="commit-${commit.hash}">
                <div class="commit-time">${timeString}</div>
                <div class="commit-file" title="${fileName}">${fileName}</div>
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

  // Show placeholder message - don't auto-select (matches Files/Automations/Scripts tabs behavior)
  document.getElementById('rightPanel').innerHTML = `<div class="empty">${t('timeline.select_commit')}</div>`;
  document.getElementById('rightPanelActions').innerHTML = '';

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
  navigateToDetail();
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
    return { status: parts[0], file: parts[1], displayFile: toDisplayPath(parts[1], { leadingSlash: true }) };
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
            <div class="file-name">${file.displayFile}</div>
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
    return { status: parts[0], file: parts[1], displayFile: toDisplayPath(parts[1], { leadingSlash: true }) };
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
        bannerText: file.status === 'A' ? `${file.displayFile} (Added)` : file.displayFile,
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
            <span class="file-name">${item.file.displayFile} (${item.file.status === 'A' ? 'Added' : item.file.status === 'D' ? 'Deleted' : 'Modified'})</span>
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
            <span class="file-name">${item.file.displayFile} (${item.file.status === 'A' ? 'Added' : item.file.status === 'D' ? 'Deleted' : 'Modified'})</span>
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
    return `${item.file.displayFile} (${action})`;
  });

  const unchangedFilesSummary = filesWithoutChanges.map(item => {
    const action = item.file.status === 'A' ? 'Added' : item.file.status === 'D' ? 'Deleted' : 'Modified';
    return `${item.file.displayFile} (${action})`;
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
        <span id="restore-btn-text">${getRestoreButtonText()}</span>
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
  if (sortState.scripts === 'deleted') {
    return loadDeletedScripts();
  }

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
  if (sortState.automations === 'deleted') {
    return loadDeletedAutomations();
  }

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
  if (sortState.files === 'deleted') {
    return loadDeletedFiles();
  }

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

// Load deleted files (files that exist in git history but not on disk)
async function loadDeletedFiles() {
  const leftPanel = document.getElementById('leftPanel');
  leftPanel.innerHTML = `<div class="empty" data-i18n="app.loading">Loading...</div>`;

  try {
    const response = await fetch(`${API}/files/deleted`);
    const data = await response.json();

    if (data.success) {
      data.files.sort((a, b) => new Date(b.lastSeenDate) - new Date(a.lastSeenDate));
      displayDeletedFiles(data.files);
    } else {
      leftPanel.innerHTML = `<div class="error" data-i18n="files.error_loading">Error loading deleted files: ${data.error}</div>`;
    }
  } catch (error) {
    leftPanel.innerHTML = `<div class="error" data-i18n="files.error_loading">Error loading deleted files: ${error.message}</div>`;
  }
}

function displayDeletedFiles(files) {
  const leftPanel = document.getElementById('leftPanel');

  if (!files || files.length === 0) {
    leftPanel.innerHTML = `<div class="empty" data-i18n="files.deleted_empty_state">${t('files.deleted_empty_state')}</div>`;
    return;
  }

  leftPanel.innerHTML = files.map(file => {
    const lastSeen = getFormattedDate(file.lastSeenDate);
    const fileId = 'deleted-file-' + file.path.replace(/[:/\.]/g, '-');
    const displayPath = toDisplayPath(file.path, { leadingSlash: true });
    return `
      <div class="file deleted" id="${fileId}" onclick="selectDeletedFile('${escapeHtml(file.path)}', '${file.lastSeenHash}')">
        <div class="file-path">
          <div class="file-name">${escapeHtml(file.name)}</div>
          <div class="file-path-text">${escapeHtml(displayPath.replace(file.name, ''))}</div>
          <div class="file-last-seen">${t('files.last_seen').replace('{date}', lastSeen)}</div>
        </div>
      </div>
    `;
  }).join('');

  document.getElementById('rightPanel').innerHTML = `<div class="empty">${t('files.select_file')}</div>`;
}

async function selectDeletedFile(filePath, lastSeenHash) {
  // Load the file history for the deleted file
  currentSelection = { type: 'deleted_file', path: filePath, hash: lastSeenHash };
  await showFileHistory(filePath);
}

// Load deleted automations (automations that exist in git history but not in current config)
async function loadDeletedAutomations() {
  const leftPanel = document.getElementById('leftPanel');
  leftPanel.innerHTML = `<div class="empty" data-i18n="app.loading">Loading...</div>`;

  try {
    const response = await fetch(`${API}/automations/deleted`);
    const data = await response.json();

    if (data.success) {
      data.automations.sort((a, b) => new Date(b.lastSeenDate) - new Date(a.lastSeenDate));
      displayDeletedAutomations(data.automations);
    } else {
      leftPanel.innerHTML = `<div class="error" data-i18n="automations.error_loading">Error loading deleted automations: ${data.error}</div>`;
    }
  } catch (error) {
    leftPanel.innerHTML = `<div class="error" data-i18n="automations.error_loading">Error loading deleted automations: ${error.message}</div>`;
  }
}

function displayDeletedAutomations(automations) {
  const leftPanel = document.getElementById('leftPanel');

  if (!automations || automations.length === 0) {
    leftPanel.innerHTML = `<div class="empty" data-i18n="automations.deleted_empty_state">${t('automations.deleted_empty_state')}</div>`;
    return;
  }

  leftPanel.innerHTML = automations.map(auto => {
    const lastSeen = getFormattedDate(auto.lastSeenDate);
    // Use the existing full ID from the API
    const syntheticId = auto.id;
    const autoId = 'deleted-auto-' + auto.id.replace(/[:/\.]/g, '-');
    return `
      <div class="file deleted" id="${autoId}" onclick="selectDeletedAutomation('${escapeHtml(syntheticId)}', '${escapeHtml(auto.name)}')">
        <div class="file-path">
          <div class="file-name">${escapeHtml(auto.name)}</div>
          <div class="file-path-text">${escapeHtml(auto.file)}</div>
          <div class="file-last-seen">${t('automations.last_seen').replace('{date}', lastSeen)}</div>
        </div>
      </div>
    `;
  }).join('');

  document.getElementById('rightPanel').innerHTML = `<div class="empty">${t('automations.select_automation')}</div>`;
}

async function selectDeletedAutomation(automationId, name) {
  currentSelection = { type: 'deleted_automation', id: automationId, name: name };
  await showAutomationHistory(automationId);
}

// Load deleted scripts (scripts that exist in git history but not in current config)
async function loadDeletedScripts() {
  const leftPanel = document.getElementById('leftPanel');
  leftPanel.innerHTML = `<div class="empty" data-i18n="app.loading">Loading...</div>`;

  try {
    const response = await fetch(`${API}/scripts/deleted`);
    const data = await response.json();

    if (data.success) {
      data.scripts.sort((a, b) => new Date(b.lastSeenDate) - new Date(a.lastSeenDate));
      displayDeletedScripts(data.scripts);
    } else {
      leftPanel.innerHTML = `<div class="error" data-i18n="scripts.error_loading">Error loading deleted scripts: ${data.error}</div>`;
    }
  } catch (error) {
    leftPanel.innerHTML = `<div class="error" data-i18n="scripts.error_loading">Error loading deleted scripts: ${error.message}</div>`;
  }
}

function displayDeletedScripts(scripts) {
  const leftPanel = document.getElementById('leftPanel');

  if (!scripts || scripts.length === 0) {
    leftPanel.innerHTML = `<div class="empty" data-i18n="scripts.deleted_empty_state">${t('scripts.deleted_empty_state')}</div>`;
    return;
  }

  leftPanel.innerHTML = scripts.map(script => {
    const lastSeen = getFormattedDate(script.lastSeenDate);
    // Use the existing full ID from the API
    const syntheticId = script.id;
    const scriptItemId = 'deleted-script-' + script.id.replace(/[:/\.]/g, '-');
    return `
      <div class="file deleted" id="${scriptItemId}" onclick="selectDeletedScript('${escapeHtml(syntheticId)}', '${escapeHtml(script.name)}')">
        <div class="file-path">
          <div class="file-name">${escapeHtml(script.name)}</div>
          <div class="file-path-text">${escapeHtml(script.file)}</div>
          <div class="file-last-seen">${t('scripts.last_seen').replace('{date}', lastSeen)}</div>
        </div>
      </div>
    `;
  }).join('');

  document.getElementById('rightPanel').innerHTML = `<div class="empty">${t('scripts.select_script')}</div>`;
}

async function selectDeletedScript(scriptId, name) {
  currentSelection = { type: 'deleted_script', id: scriptId, name: name };
  await showScriptHistory(scriptId);
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
    // Handle both string paths (legacy/search) and object paths (new format),
    // while rendering mirrored external files as virtual /share and /media paths.
    const repoPath = typeof fileObj === 'string' ? fileObj : fileObj.path;
    const displayPath = toDisplayPath(repoPath);

    if (displayPath.startsWith(currentFolder)) {
      const relativePath = displayPath.substring(currentFolder.length);
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
          path: repoPath
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
  navigateToDetail();
  document.querySelectorAll('.file').forEach(f => f.classList.remove('selected'));

  let fileId;
  if (sortState.files === 'deleted') {
    fileId = 'deleted-file-' + filePath.replace(/[:/\.]/g, '-');
  } else {
    fileId = 'file-' + filePath.replace(/\//g, '-').replace(/\./g, '-');
  }

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

  // Preserve 'deleted_file' type if already set, otherwise set as regular file
  if (currentSelection && currentSelection.type === 'deleted_file') {
    currentSelection.file = filePath;
  } else {
    currentSelection = { type: 'file', file: filePath };
  }

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
    // ◀ (prev) goes to older (higher index) unless legacy mode; disabled at the end
    // ▶ (next) goes to newer (lower index) unless legacy mode; disabled at the start
    if (reverseArrowDirection) {
      prevBtn.disabled = currentFileHistoryIndex === 0;
      nextBtn.disabled = currentFileHistoryIndex === currentFileHistory.length - 1;
    } else {
      prevBtn.disabled = currentFileHistoryIndex === currentFileHistory.length - 1;
      nextBtn.disabled = currentFileHistoryIndex === 0;
    }
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
      const autoId = 'auto-' + auto.id.replace(/[:/\.]/g, '-');
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
  navigateToDetail();
  document.querySelectorAll('.file').forEach(f => f.classList.remove('selected'));

  let autoId;
  if (sortState.automations === 'deleted') {
    autoId = 'deleted-auto-' + automationId.replace(/[:/\.]/g, '-');
  } else {
    autoId = 'auto-' + automationId.replace(/[:/\.]/g, '-');
  }

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

  if (sortState.automations !== 'deleted') {
    currentSelection = { type: 'automation', id: automationId };
  }

  // Get the automation name for immediate display
  let auto = allAutomations.find(a => a.id === automationId);
  const displayName = auto ? auto.name : (currentSelection?.name || 'Automation');

  // Set up the panel title immediately (no loading placeholder - matches Files tab)
  document.getElementById('rightPanelTitle').textContent = displayName;
  document.getElementById('rightPanelActions').innerHTML = '';
  document.getElementById('rightPanel').innerHTML = '';

  try {
    // PROGRESSIVE LOADING: First fetch just commit metadata (fast - no YAML parsing)
    const metadataResponse = await fetch(`${API}/automation/${encodeURIComponent(automationId)}/history-metadata`);
    const metadataResult = await metadataResponse.json();

    if (!metadataResult.success || metadataResult.commits.length === 0) {
      document.getElementById('rightPanel').innerHTML = `<div class="empty">${t('history.no_changes')}</div>`;
      return;
    }

    // Handle deleted automations (which won't be found in allAutomations)
    if (!auto && currentSelection && currentSelection.type === 'deleted_automation') {
      const parts = automationId.split(':');
      const file = parts.length >= 2 ? decodeURIComponent(parts[1]) : 'automations.yaml';
      auto = {
        id: automationId,
        name: currentSelection.name,
        file: file,
        content: null
      };
    }

    // Get current content for comparison
    let currentContent = '';
    if (auto && auto.content) {
      currentContent = dumpYaml(auto.content);
    }

    // Initialize history state
    currentAutomationHistory = [];
    currentAutomationHistoryIndex = 0;
    let lastKeptContent = null;
    let isFirstVersion = true;
    isScanningHistory = true;

    // PROGRESSIVE LOADING: Fetch content PER COMMIT (like Files tab)
    for (let i = 0; i < metadataResult.commits.length; i++) {
      const commit = metadataResult.commits[i];

      // Fetch content for this specific commit
      const contentResponse = await fetch(`${API}/automation/${encodeURIComponent(automationId)}/at-commit?commitHash=${encodeURIComponent(commit.hash)}`);
      const contentResult = await contentResponse.json();

      if (!contentResult.success || !contentResult.automation) {
        continue; // Skip commits where automation doesn't exist
      }

      const commitContent = dumpYaml(contentResult.automation);

      // Check if there are visible differences compared to the CURRENT version
      const diffVsCurrent = generateDiff(commitContent, currentContent, {
        returnNullIfNoChanges: true,
        filePath: auto?.file
      });

      // Skip if identical to live
      if (diffVsCurrent === null) continue;

      // Check against the last kept version to avoid consecutive duplicates
      if (lastKeptContent !== null) {
        const diffVsLast = generateDiff(commitContent, lastKeptContent, {
          returnNullIfNoChanges: true,
          filePath: auto?.file
        });
        if (diffVsLast === null) continue;
      }

      // Add this version to history
      currentAutomationHistory.push({
        hash: commit.hash,
        date: commit.date,
        message: commit.message,
        author: commit.author,
        automation: contentResult.automation,
        yamlContent: commitContent
      });
      lastKeptContent = commitContent;

      // Display immediately when we find the first valid version (INSTANT!)
      if (isFirstVersion) {
        isFirstVersion = false;
        document.getElementById('rightPanelTitle').textContent = auto ? auto.name : 'Automation';
        document.getElementById('rightPanelActions').innerHTML = `<button class="btn restore" onclick="restoreAutomationVersion('${automationId}')" title="${t('diff.tooltip_overwrite_automation')}">${getRestoreButtonText()}</button>`;
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
      const mostRecentHash = metadataResult.commits.length > 0 ? metadataResult.commits[0].hash : '';
      const mostRecentCommitDate = metadataResult.commits.length > 0 ? metadataResult.commits[0].date : new Date();

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
        filePath: auto?.file
      });
    }
  } catch (error) {
    console.error('Error loading automation history:', error);
    document.getElementById('rightPanel').innerHTML = `
          <div class="empty">${t('history.error_loading', { error: error.message })}</div>
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
              <button class="btn" id="autoPrevBtn" onclick="navigateAutomationHistory(reverseArrowDirection ? -1 : 1)" ${reverseArrowDirection ? (currentAutomationHistoryIndex === 0 ? 'disabled' : '') : (currentAutomationHistoryIndex === currentAutomationHistory.length - 1 ? 'disabled' : '')} style="border: 1px solid var(--border-subtle); min-width: 36px; padding: 8px 12px;">◀</button>
              <button class="btn" id="autoNextBtn" onclick="navigateAutomationHistory(reverseArrowDirection ? 1 : -1)" ${reverseArrowDirection ? (currentAutomationHistoryIndex === currentAutomationHistory.length - 1 ? 'disabled' : '') : (currentAutomationHistoryIndex === 0 ? 'disabled' : '')} style="border: 1px solid var(--border-subtle); min-width: 36px; padding: 8px 12px;">▶</button>
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

  // Handle deleted automations (which won't be found in allAutomations)
  let auto = allAutomations.find(a => a.id === currentSelection.id);

  if (!auto && currentSelection && currentSelection.type === 'deleted_automation') {
    auto = { content: null, line: 0 };
  }

  if (!auto) return;

  const currentContent = auto.content ? dumpYaml(auto.content) : '';
  let leftContent = '';
  let rightContent = '';
  let leftLabel = '';
  let rightLabel = '';

  if (compareToCurrent) {
    // Compare to Current ON: Compare current version (left) vs commit version (right)
    const commitContent = currentCommit.yamlContent || dumpYaml(currentCommit.automation);

    // For deleted automations, we want to show a single panel view of the historical content
    if (currentSelection.type === 'deleted_automation') {
      leftContent = commitContent;
      rightContent = commitContent;
      leftLabel = formatDateForBanner(currentCommit.date);
      rightLabel = 'Content';
    } else {
      leftContent = currentContent;
      rightContent = commitContent;
      leftLabel = 'Current Version';
      rightLabel = formatDateForBanner(currentCommit.date);
    }
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

  // NOTE: startLineOffset must be 0 here. The diff compares the isolated YAML
  // of a single automation (not the full automations.yaml file), so line numbers
  // always start at 1. Using auto.line (live file position) was WRONG — it shifts
  // after automations are deleted, causing diffs to show the wrong automation's content.

  // renderDiff expects (commitContent, currentContent) and calls generateDiff(currentContent, commitContent)
  // i.e. generateDiff(Left, Right)
  // So we pass (Right, Left) to renderDiff
  const diffHtml = renderDiff(rightContent, leftContent, document.getElementById('automationDiffContent'), {
    leftLabel: leftLabel,
    rightLabel: rightLabel,
    startLineOffset: 0,
    filePath: 'automations.yaml'
  });

  if ((diffHtml) || (currentSelection && currentSelection.type === 'deleted_automation')) {
    document.getElementById('rightPanelActions').innerHTML = `<button class="btn restore" onclick="restoreAutomationVersion('${escapeHtml(currentSelection.id)}')" title="${t('diff.tooltip_overwrite_automation')}">${getRestoreButtonText()}</button>`;
  } else {
    document.getElementById('rightPanelActions').innerHTML = '';
  }
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
    if (reverseArrowDirection) {
      prevBtn.disabled = currentAutomationHistoryIndex === 0;
      nextBtn.disabled = currentAutomationHistoryIndex === currentAutomationHistory.length - 1;
    } else {
      prevBtn.disabled = currentAutomationHistoryIndex === currentAutomationHistory.length - 1;
      nextBtn.disabled = currentAutomationHistoryIndex === 0;
    }
  }
}


function displayScripts(scripts) {
  let html = '';

  if (scripts.length === 0) {
    html = `<div class="empty">${t('scripts.empty_state')}</div>`;
  } else {
    scripts.forEach(script => {
      const scriptId = 'script-' + script.id.replace(/[:/\.]/g, '-');
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
  navigateToDetail();
  document.querySelectorAll('.file').forEach(f => f.classList.remove('selected'));

  let scriptElId;
  if (sortState.scripts === 'deleted') {
    scriptElId = 'deleted-script-' + scriptId.replace(/[:/\.]/g, '-');
  } else {
    scriptElId = 'script-' + scriptId.replace(/[:/\.]/g, '-');
  }

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

  if (sortState.scripts !== 'deleted') {
    currentSelection = { type: 'script', id: scriptId };
  }

  // Get the script name for immediate display
  let script = allScripts.find(s => s.id === scriptId);
  const displayName = script ? script.name : (currentSelection?.name || 'Script');

  // Set up the panel title immediately (no loading placeholder - matches Files tab)
  document.getElementById('rightPanelTitle').textContent = displayName;
  document.getElementById('rightPanelActions').innerHTML = '';
  document.getElementById('rightPanel').innerHTML = '';

  try {
    // PROGRESSIVE LOADING: First fetch just commit metadata (fast - no YAML parsing)
    const metadataResponse = await fetch(`${API}/script/${encodeURIComponent(scriptId)}/history-metadata`);
    const metadataResult = await metadataResponse.json();

    if (!metadataResult.success || metadataResult.commits.length === 0) {
      document.getElementById('rightPanel').innerHTML = `<div class="empty">${t('history.no_changes')}</div>`;
      return;
    }

    // Handle deleted scripts
    if (!script && currentSelection && currentSelection.type === 'deleted_script') {
      const parts = scriptId.split(':');
      const file = parts.length >= 2 ? decodeURIComponent(parts[1]) : 'scripts.yaml';
      script = {
        id: scriptId,
        name: currentSelection.name,
        file: file,
        content: null
      };
    }

    // Get current content for comparison
    let currentContent = '';
    if (script && script.content) {
      currentContent = dumpYaml(script.content);
    }

    // Initialize history state
    currentScriptHistory = [];
    currentScriptHistoryIndex = 0;
    let lastKeptContent = null;
    let isFirstVersion = true;
    isScanningHistory = true;

    // PROGRESSIVE LOADING: Fetch content PER COMMIT (like Files tab)
    for (let i = 0; i < metadataResult.commits.length; i++) {
      const commit = metadataResult.commits[i];

      // Fetch content for this specific commit
      const contentResponse = await fetch(`${API}/script/${encodeURIComponent(scriptId)}/at-commit?commitHash=${encodeURIComponent(commit.hash)}`);
      const contentResult = await contentResponse.json();

      if (!contentResult.success || !contentResult.script) {
        continue; // Skip commits where script doesn't exist
      }

      const commitContent = dumpYaml(contentResult.script);

      // Check if there are visible differences compared to the CURRENT version
      const diffVsCurrent = generateDiff(commitContent, currentContent, {
        returnNullIfNoChanges: true,
        filePath: script?.file
      });

      // Skip if identical to live
      if (diffVsCurrent === null) continue;

      // Check against the last kept version to avoid consecutive duplicates
      if (lastKeptContent !== null) {
        const diffVsLast = generateDiff(commitContent, lastKeptContent, {
          returnNullIfNoChanges: true,
          filePath: script?.file
        });
        if (diffVsLast === null) continue;
      }

      // Add this version to history
      currentScriptHistory.push({
        hash: commit.hash,
        date: commit.date,
        message: commit.message,
        author: commit.author,
        script: contentResult.script,
        yamlContent: commitContent
      });
      lastKeptContent = commitContent;

      // Display immediately when we find the first valid version (INSTANT!)
      if (isFirstVersion) {
        isFirstVersion = false;
        document.getElementById('rightPanelTitle').textContent = script ? script.name : 'Script';
        document.getElementById('rightPanelActions').innerHTML = `<button class="btn restore" onclick="restoreScriptVersion('${scriptId}')" title="${t('diff.tooltip_overwrite_script')}">${getRestoreButtonText()}</button>`;
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
      const mostRecentHash = metadataResult.commits.length > 0 ? metadataResult.commits[0].hash : '';
      const mostRecentCommitDate = metadataResult.commits.length > 0 ? metadataResult.commits[0].date : new Date();

      document.getElementById('rightPanelTitle').textContent = script ? script.name : 'Script';
      document.getElementById('itemsSubtitle').textContent = '';
      document.getElementById('rightPanelActions').innerHTML = '';

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

      renderDiff(currentContent, currentContent, document.getElementById('scriptDiffContent'), {
        leftLabel: 'Current Version',
        rightLabel: 'Current Version',
        filePath: script?.file
      });
    }
  } catch (error) {
    console.error('Error loading script history:', error);
    document.getElementById('rightPanel').innerHTML = `
          <div class="empty">${t('history.error_loading', { error: error.message })}</div>
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
              <button class="btn" id="scriptPrevBtn" onclick="navigateScriptHistory(reverseArrowDirection ? -1 : 1)" ${reverseArrowDirection ? (currentScriptHistoryIndex === 0 ? 'disabled' : '') : (currentScriptHistoryIndex === currentScriptHistory.length - 1 ? 'disabled' : '')} style="border: 1px solid var(--border-subtle); min-width: 36px; padding: 8px 12px;">◀</button>
              <button class="btn" id="scriptNextBtn" onclick="navigateScriptHistory(reverseArrowDirection ? 1 : -1)" ${reverseArrowDirection ? (currentScriptHistoryIndex === currentScriptHistory.length - 1 ? 'disabled' : '') : (currentScriptHistoryIndex === 0 ? 'disabled' : '')} style="border: 1px solid var(--border-subtle); min-width: 36px; padding: 8px 12px;">▶</button>
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

  let script = allScripts.find(s => s.id === currentSelection.id);

  // Handle deleted scripts
  if (!script && currentSelection && currentSelection.type === 'deleted_script') {
    script = { content: null, line: 0 };
  }

  if (!script) return;

  const currentContent = script.content ? dumpYaml(script.content) : '';
  let leftContent = '';
  let rightContent = '';
  let leftLabel = '';
  let rightLabel = '';

  if (compareToCurrent) {
    // Compare to Current ON: Compare current version (left) vs commit version (right)
    const commitContent = currentCommit.yamlContent || dumpYaml(currentCommit.script);

    // For deleted scripts, we want to show a single panel view of the historical content
    if (currentSelection.type === 'deleted_script') {
      leftContent = commitContent;
      rightContent = commitContent;
      leftLabel = formatDateForBanner(currentCommit.date);
      rightLabel = 'Content';
    } else {
      leftContent = currentContent;
      rightContent = commitContent;
      leftLabel = 'Current Version';
      rightLabel = formatDateForBanner(currentCommit.date);
    }
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

  // NOTE: startLineOffset must be 0 here. The diff compares the isolated YAML
  // of a single script (not the full scripts.yaml file), so line numbers
  // always start at 1. Using script.line (live file position) was WRONG — it shifts
  // after scripts are deleted, causing diffs to show the wrong script's content.

  // renderDiff expects (commitContent, currentContent) -> generateDiff(currentContent, commitContent)
  // So we pass (Right, Left) to renderDiff
  const diffHtml = renderDiff(rightContent, leftContent, document.getElementById('scriptDiffContent'), {
    leftLabel: leftLabel,
    rightLabel: rightLabel,
    startLineOffset: 0,
    filePath: 'scripts.yaml'
  });

  if ((diffHtml) || (currentSelection && currentSelection.type === 'deleted_script')) {
    document.getElementById('rightPanelActions').innerHTML = `<button class="btn restore" onclick="restoreScriptVersion('${escapeHtml(currentSelection.id)}')" title="${t('diff.tooltip_overwrite_script')}">${getRestoreButtonText()}</button>`;
  } else {
    document.getElementById('rightPanelActions').innerHTML = '';
  }
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
    if (reverseArrowDirection) {
      prevBtn.disabled = currentScriptHistoryIndex === 0;
      nextBtn.disabled = currentScriptHistoryIndex === currentScriptHistory.length - 1;
    } else {
      prevBtn.disabled = currentScriptHistoryIndex === currentScriptHistory.length - 1;
      nextBtn.disabled = currentScriptHistoryIndex === 0;
    }
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
  const formattedDate = commitDate ? formatDateForBanner(commitDate) : getFormattedDate(new Date());
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

  // Set the panel title - add "(Deleted)" if viewing a deleted file, or "(Added)" if the file was added
  let title = toDisplayPath(filePath, { leadingSlash: true });
  if (currentSelection && currentSelection.type === 'deleted_file') {
    title += ' (Deleted)';
  } else if (currentFileHistory.length > 0) {
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
                                            <button class="btn" id="prevBtn" onclick="navigateFileHistory(reverseArrowDirection ? -1 : 1)" ${reverseArrowDirection ? (currentFileHistoryIndex === 0 ? 'disabled' : '') : (currentFileHistoryIndex === currentFileHistory.length - 1 ? 'disabled' : '')} style="border: 1px solid var(--border-subtle); min-width: 36px; padding: 8px 12px;">◀</button>
                                            <button class="btn" id="nextBtn" onclick="navigateFileHistory(reverseArrowDirection ? 1 : -1)" ${reverseArrowDirection ? (currentFileHistoryIndex === currentFileHistory.length - 1 ? 'disabled' : '') : (currentFileHistoryIndex === 0 ? 'disabled' : '')} style="border: 1px solid var(--border-subtle); min-width: 36px; padding: 8px 12px;">▶</button>
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
  return getFormattedDate(dateString);
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
  if (reverseArrowDirection) {
    document.getElementById('prevBtn').disabled = currentFileHistoryIndex === 0;
    document.getElementById('nextBtn').disabled = currentFileHistoryIndex === currentFileHistory.length - 1;
  } else {
    document.getElementById('prevBtn').disabled = currentFileHistoryIndex === currentFileHistory.length - 1;
    document.getElementById('nextBtn').disabled = currentFileHistoryIndex === 0;
  }

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

    // Check if this is a deleted file
    const isDeletedFile = currentSelection && currentSelection.type === 'deleted_file';

    if (isDeletedFile) {
      // For deleted files, show the historical version content and indicate the file no longer exists
      const commitResponse = await fetch(`${API}/git/file-at-commit?filePath=${encodeURIComponent(filePath)}&commitHash=${currentCommit.hash}`);
      const commitData = await commitResponse.json();
      const commitContent = commitData.success ? commitData.content : '';

      // For deleted files, we want to show a single panel view of the historical content
      // To achieve this, we set rightContent to be the same as leftContent.
      // This causes generateDiff to see no changes and render a single panel using the left label.
      leftContent = commitContent;
      rightContent = commitContent;
      leftLabel = formatDateForBanner(currentCommit.date);
      rightLabel = 'File Content';
    } else if (isNewlyAdded) {
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

  // Show restore button if there are changes (regardless of comparison mode) or if it's a deleted file
  const isDeletedFile = currentSelection && currentSelection.type === 'deleted_file';
  if ((diffHtml && !isNewlyAdded) || isDeletedFile) {
    document.getElementById('rightPanelActions').innerHTML = `<button class="btn restore" onclick="restoreFileVersion('${escapeHtml(filePath)}')" title="${t('diff.tooltip_overwrite_file')}">${getRestoreButtonText()}</button>`;
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
  const commitDate = getFormattedDate(currentCommit.date);
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

      triggerConfetti();

      // Yield to the browser so the confetti has time to render before heavy diff generation
      setTimeout(() => {
        showFileHistory(filePath);
      }, 50);
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
  let auto = allAutomations.find(a => a.id === automationId);

  if (!auto && currentSelection && currentSelection.type === 'deleted_automation' && currentSelection.id === automationId) {
    auto = { id: automationId, name: currentSelection.name || 'Deleted Automation' };
  }

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
      triggerConfetti();
      // Yield to the browser so the confetti has time to render
      setTimeout(() => {
        loadAutomations();
      }, 50);
    } else {
      showNotification('Error: ' + data.error, 'error');
    }
  } catch (error) {
    console.error('Error:', error);
    showNotification('Error restoring automation: ' + error.message, 'error');
  }
}

async function restoreScriptVersion(scriptId) {
  let script = allScripts.find(s => s.id === scriptId);

  if (!script && currentSelection && currentSelection.type === 'deleted_script' && currentSelection.id === scriptId) {
    script = { id: scriptId, name: currentSelection.name || 'Deleted Script' };
  }

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
      triggerConfetti();
      // Yield to the browser so the confetti has time to render
      setTimeout(() => {
        loadScripts();
      }, 50);
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
      <div class="segmented-control" style="cursor: pointer; grid-template-columns: 1fr;" onclick="cycleDiffStyle()" title="Click to cycle diff styles">
        <div class="segmented-control-slider" style="width: calc(100% - 8px);"></div>
        <label style="cursor: pointer; color: var(--text-primary);">${leftLabel}</label>
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
      <div class="segmented-control" style="cursor: pointer;" onclick="cycleDiffStyle()" title="Click to cycle diff styles">
        <input type="radio" name="diffHeaderSplit" id="diffHeaderLeft" checked disabled>
        <label for="diffHeaderLeft" style="cursor: pointer;">${leftLabel}</label>
        <input type="radio" name="diffHeaderSplit" id="diffHeaderRight" disabled>
        <label for="diffHeaderRight" style="cursor: pointer;">${rightLabel}</label>
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
      <div class="diff-header-unified" style="cursor: pointer;" onclick="cycleDiffStyle()" title="Click to cycle diff styles">
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
  if (duration > 0) {
    setTimeout(() => {
      notification.style.animation = 'notificationSlideOut 0.3s ease-in';
      setTimeout(() => {
        if (notification.parentNode) {
          notification.remove();
        }
      }, 300);
    }, duration);
  }

  return notification;
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
      commitDate = getFormattedDate(commit.date);
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
      return { status: parts[0], file: parts[1], displayFile: toDisplayPath(parts[1], { leadingSlash: true }) };
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
                  ${file.displayFile} (${file.status === 'A' ? 'Added' : file.status === 'D' ? 'Deleted' : 'Modified'})
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
        const message = t(key).replace('{file}', toDisplayPath(filePath, { leadingSlash: true }));

        // Check if it's a Lovelace file and offer restart
        if (filePath.includes('.storage/lovelace')) {
          showNotification(message, 'success', 8000, {
            label: 'Restart Home Assistant',
            callback: restartHomeAssistant
          });
        } else {
          showNotification(message, 'success');
        }

        triggerConfetti();
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
        const fileNames = files.map(f => toDisplayPath(f, { leadingSlash: true })).join(', ');

        let message;
        if (data.automationReloaded || data.scriptReloaded) {
          // Show "restored and reloaded" message like other tabs
          message = t('timeline.files_restored_and_reloaded', { files: fileNames });
        } else {
          // Simple restored message
          message = t('timeline.files_restored', { files: fileNames });
        }

        showNotification(message);
        triggerConfetti();
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
        triggerConfetti();
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
        triggerConfetti();
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
        triggerConfetti();
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
        triggerConfetti();
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
        message = t(key).replace('{file}', toDisplayPath(filePath, { leadingSlash: true }));

        // Check if it's a Lovelace file and offer restart
        if (filePath.includes('.storage/lovelace')) {
          showNotification(message, 'success', 8000, {
            label: 'Restart Home Assistant',
            callback: restartHomeAssistant
          });
          triggerConfetti();
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
          triggerConfetti();
          refreshCurrent();
          return; // Exit early
        }
      } else {
        // Fallback
        message = data.message || t('timeline.commit_restored');
      }

      showNotification(message, 'success');
      triggerConfetti();
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
    textEl.textContent = getRestoreButtonText();
  }
}

function showHardResetConfirmation(hash) {
  // Find the commit info
  const commit = allCommits.find(c => c.hash === hash);

  let formattedDate = 'Unknown';
  if (commit) {
    formattedDate = getFormattedDate(commit.date);
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

      triggerConfetti();

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
// CONFETTI MODE FUNCTIONS
// ========================================


// Toggle Confetti Mode preference (saves to localStorage only; no visual effect on toggle)
function toggleConfettiMode() {
  const checkbox = document.getElementById('confettiMode');
  // onclick fires before checkbox toggles, so check the OPPOSITE
  const willBeEnabled = !checkbox.checked;
  localStorage.setItem('confettiModeEnabled', willBeEnabled ? 'true' : 'false');
}

// Initialize Confetti Mode from localStorage (defaults to off)
function initConfettiMode() {
  const saved = localStorage.getItem('confettiModeEnabled');
  const checkbox = document.getElementById('confettiMode');
  if (checkbox && saved === 'true') {
    checkbox.checked = true;
  }
}

// Returns true if confetti mode is currently enabled
function isConfettiModeEnabled() {
  return localStorage.getItem('confettiModeEnabled') === 'true';
}

/**
 * triggerConfetti() — realistic falling confetti.
 *
 * Physics model (same approach as canvas-confetti):
 *   • Each piece has an initial (vx, vy) velocity that decays with drag each step
 *   • Gravity increments vy every step → smooth accelerating fall
 *   • The visual "flutter" of a paper piece is a rotateY wobble (face→edge→back)
 *     NOT lateral position oscillation (which causes the zigzag)
 *   • rotateZ adds a gentle lazy 2-D spin
 */
function triggerConfetti() {
  if (!isConfettiModeEnabled()) return;

  const container = document.getElementById('confettiContainer');
  if (!container) return;

  // Perspective on the container makes rotateY look truly 3-D
  container.style.perspective = '700px';

  const COUNT = 250;
  const W     = window.innerWidth;
  const H     = window.innerHeight;

  const SHAPES = ['rect', 'rect', 'rect', 'rect', 'circle', 'streamer'];

  const COLORS = [
    '#ff6b6b','#ff4757','#f9ca24','#f0932b',
    '#6ab04c','#badc58','#22a6b3','#30336b',
    '#be2edd','#e056fd','#ff9ff3','#54a0ff',
    '#ff6348','#ffd32a','#0abde3','#10ac84',
    '#ff9f43','#ee5a24','#c0392b','#8e44ad'
  ];

  for (let i = 0; i < COUNT; i++) {
    const el    = document.createElement('div');
    const color = COLORS[Math.floor(Math.random() * COLORS.length)];
    const shape = SHAPES[Math.floor(Math.random() * SHAPES.length)];

    let w, h;
    if (shape === 'circle') {
      w = h = 5 + Math.random() * 7;
    } else if (shape === 'streamer') {
      w = 2 + Math.random() * 2;
      h = 14 + Math.random() * 18;
    } else {
      w = 9 + Math.random() * 9;   // landscape rect — wider than tall
      h = 4 + Math.random() * 5;
    }

    const startX = Math.random() * W;
    const startY = -(h + Math.random() * 400); // spread across 400px height for staggered entry

    el.style.cssText = `
      position: absolute;
      left: ${startX}px;
      top: ${startY}px;
      width: ${w}px;
      height: ${h}px;
      background: ${color};
      border-radius: ${shape === 'circle' ? '50%' : '1px'};
      pointer-events: none;
      will-change: transform, opacity;
      transform-origin: center center;
    `;

    container.appendChild(el);

    // ── Physics constants ────────────────────────────────────────────────────
    const GRAVITY      = 0.8;    // downward acceleration
    const DRAG         = 0.96;   // air resistance
    const STEPS        = 120;    // more steps for full-screen fall

    // Initial velocity — larger spread
    let vx = (Math.random() - 0.5) * 15;  // px per step
    let vy = 1 + Math.random() * 3;        // px per step

    // Visual rotation — purely decorative, does NOT affect position
    const wobbleSpeed  = (2 + Math.random() * 4) * (Math.random() < 0.5 ? 1 : -1);
    const wobbleStart  = Math.random() * 360; // deg, random start angle
    const spinZTotal   = (Math.random() - 0.5) * 160; 

    // Timing
    const duration = 2000 + Math.random() * 2000;
    const delay    = Math.random() * 800;

    // ── Build keyframes via Euler integration ────────────────────────────────
    const keyframes = [];
    let px = 0, py = 0;

    for (let s = 0; s <= STEPS; s++) {
      const p = s / STEPS; // 0 → 1

      if (s > 0) {
        vx *= DRAG;
        vy *= DRAG;
        vy += GRAVITY;
        px += vx;
        py += vy;
      }

      // rotateY: the paper-flip wobble (face→edge→back of piece)
      const rotY = wobbleStart + wobbleSpeed * s * 6;
      // rotateZ: slow in-plane tumble
      const rotZ = spinZTotal * p;

      // Opacity: stay solid, gentle fade-out at bottom
      const opacity = p > 0.8 ? (1 - p) / 0.2 : 1;

      keyframes.push({
        transform: `translate(${px}px, ${py}px) rotateY(${rotY}deg) rotateZ(${rotZ}deg)`,
        opacity,
        offset: p
      });
    }

    el.animate(keyframes, {
      duration,
      delay,
      easing:    'linear',
      fill:      'forwards',
      composite: 'replace'
    }).onfinish = () => el.remove();
  }
}


async function handleCloudProviderChange() {
  const isGithub = document.getElementById('cloudProviderGithub').checked;
  const githubSection = document.getElementById('githubConfigSection');
  const customSection = document.getElementById('customConfigSection');
  const urlInput = document.getElementById('cloudRemoteUrl');

  if (isGithub) {
    githubSection.style.display = 'block';
    customSection.style.display = 'none';
    // Refresh GitHub user state when switching to it
    loadGitHubUser();
  } else {
    githubSection.style.display = 'none';
    customSection.style.display = 'block';

    // When switching to Custom, restore the stored Custom URL and connected state
    try {
      const response = await fetch(`${API}/cloud-sync/settings`);
      const data = await response.json();
      if (data.success && data.settings.customRemoteUrl) {
        // Restore URL to input
        if (urlInput) {
          urlInput.value = data.settings.customRemoteUrl;
        }

        // Show connected state
        const customNotConnected = document.getElementById('customNotConnected');
        const customConnected = document.getElementById('customConnected');
        const repoLink = document.getElementById('customRepoLink');

        if (customNotConnected && customConnected) {
          customNotConnected.style.display = 'none';
          customConnected.style.display = 'block';

          if (repoLink) {
            const cleanUrl = stripTokenFromUrl(data.settings.customRemoteUrl);
            const parts = cleanUrl.replace(/\.git$/, '').split('/').filter(p => p);
            // Show User/Owner (2nd to last part) or fallback to Repo Name (last part)
            const repoName = parts.length >= 2 ? parts[parts.length - 2] : (parts.pop() || 'Repository');
            repoLink.textContent = repoName;
            repoLink.href = cleanUrl.replace(/\.git$/, '');

            // Try to load avatar
            updateCustomRepoAvatar(data.settings.customRemoteUrl);
          }
        }
      } else {
        // No custom URL - show input state
        const customNotConnected = document.getElementById('customNotConnected');
        const customConnected = document.getElementById('customConnected');
        if (customNotConnected) customNotConnected.style.display = 'block';
        if (customConnected) customConnected.style.display = 'none';
      }
    } catch (e) {
      console.log('[handleCloudProviderChange] Could not fetch custom URL:', e);
    }
  }

  // Auto-save settings when provider changes (silent - no notification)
  // This ensures Push Now immediately uses the new provider
  await saveCloudSyncSettings(true);
}

// ============================
// Timeline Context Menu (Right-click)
// ============================

let contextMenuTarget = null;

function showTimelineContextMenu(event, commitHash) {
  event.preventDefault();
  event.stopPropagation();

  contextMenuTarget = commitHash;

  // Remove any existing context menu
  hideTimelineContextMenu();

  // Get commit info for display
  const commit = allCommits.find(c => c.hash === commitHash);
  const commitDate = commit ? getFormattedDate(commit.date) : commitHash.substring(0, 8);

  // Count commits that will be removed
  const commitIndex = allCommits.findIndex(c => c.hash === commitHash);
  const commitsToRemove = commitIndex; // Commits before this one in the array (newer)

  // Create context menu
  const menu = document.createElement('div');
  menu.id = 'timeline-context-menu';
  menu.className = 'context-menu';
  menu.innerHTML = `
    <div class="context-menu-item" onclick="confirmSoftReset('${commitHash}', ${commitsToRemove})">
      <span class="context-menu-text">Reset Timeline Here</span>
    </div>
    <div class="context-menu-separator"></div>
    <div class="context-menu-item" onclick="restoreAllFilesFromContext('${commitHash}')">
      <span class="context-menu-text">Restore All Files Here</span>
    </div>
  `;
  console.log('[context-menu] Menu created for commit:', commitHash, 'commits to remove:', commitsToRemove);

  // Position menu at cursor
  menu.style.left = event.pageX + 'px';
  menu.style.top = event.pageY + 'px';

  document.body.appendChild(menu);

  // Close menu when clicking elsewhere
  setTimeout(() => {
    document.addEventListener('click', hideTimelineContextMenu, { once: true });
    document.addEventListener('contextmenu', hideTimelineContextMenu, { once: true });
  }, 0);
}

function hideTimelineContextMenu() {
  const menu = document.getElementById('timeline-context-menu');
  if (menu) {
    menu.remove();
  }
}

function restoreAllFilesFromContext(commitHash) {
  hideTimelineContextMenu();
  showHardResetConfirmation(commitHash);
}

function confirmSoftReset(commitHash, commitsToRemove) {
  console.log('[confirmSoftReset] Called with:', commitHash, commitsToRemove);
  hideTimelineContextMenu();

  // Get commit info for display (same format as hard reset)
  const commit = allCommits.find(c => c.hash === commitHash);
  let formattedDate = 'Unknown';
  if (commit) {
    formattedDate = getFormattedDate(commit.date);
  }

  // Check if this is the most recent commit
  if (commitsToRemove === 0) {
    showNotification('This is already the most recent version', 'info', 3000);
    return;
  }

  // Create confirmation dialog (same pattern as hard reset modal)
  const modalHTML = `
    <div class="modal-backdrop active" id="soft-reset-modal" onclick="if(event.target === this) closeSoftResetDialog()">
      <div class="modal-content hard-reset-dialog">
        <h3>Reset Timeline?</h3>
        
        <p>This will reset the timeline back to ${formattedDate}.</p>
        
        <div class="modal-actions">
          <button class="btn btn-secondary" onclick="closeSoftResetDialog()">Cancel</button>
          <button class="btn restore" onclick="executeSoftReset('${commitHash}')">Reset Timeline</button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', modalHTML);
  console.log('[confirmSoftReset] Dialog created');
}

function closeSoftResetDialog() {
  const modal = document.getElementById('soft-reset-modal');
  if (modal) {
    modal.remove();
  }
}

async function executeSoftReset(commitHash) {
  closeSoftResetDialog();

  console.log('[soft-reset] Starting soft reset to:', commitHash);
  showNotification('Resetting timeline...', 'info', 2000);

  try {
    const response = await fetch(`${API}/git/soft-reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commitHash })
    });

    const data = await response.json();
    console.log('[soft-reset] Server response:', data);

    if (data.success) {
      showNotification('Timeline reset!', 'success', 4000);
      // Refresh the timeline
      await loadTimeline();
    } else {
      showNotification(`Reset failed: ${data.error}`, 'error', 5000);
    }
  } catch (error) {
    console.error('[soft-reset] Error:', error);
    showNotification(`Reset error: ${error.message}`, 'error', 5000);
  }
}
