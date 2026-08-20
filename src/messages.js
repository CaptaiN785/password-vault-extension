// Message type constants shared by the service worker, popup and options page.
// content.js cannot import modules, so it hardcodes the same strings -- keep them in sync.

// content script <- background
export const PING = 'PING';
export const DETECT = 'DETECT';
export const FILL = 'FILL';
export const CAPTURE = 'CAPTURE';
export const TOAST = 'TOAST';
export const PICK = 'PICK';
export const SAVE_PROMPT = 'SAVE_PROMPT';

// background <- content script
export const SUBMIT_DETECTED = 'SUBMIT_DETECTED';
export const PICK_RESULT = 'PICK_RESULT';

// background <- popup / options
export const STATUS = 'STATUS';
export const CREATE_VAULT = 'CREATE_VAULT';
export const UNLOCK = 'UNLOCK';
export const LOCK = 'LOCK';
export const LIST_ENTRIES = 'LIST_ENTRIES';
export const SAVE_ENTRY = 'SAVE_ENTRY';
export const DELETE_ENTRY = 'DELETE_ENTRY';
export const FILL_ENTRY = 'FILL_ENTRY';
export const IMPORT_ENTRIES = 'IMPORT_ENTRIES';
export const EXPORT_VAULT = 'EXPORT_VAULT';
export const CHANGE_MASTER = 'CHANGE_MASTER';
export const GET_SETTINGS = 'GET_SETTINGS';
export const SET_SETTINGS = 'SET_SETTINGS';
export const COPY_CLEARED = 'COPY_CLEARED';
export const SCHEDULE_CLIPBOARD_CLEAR = 'SCHEDULE_CLIPBOARD_CLEAR';
export const RESTORE_VAULT = 'RESTORE_VAULT';

// Touch ID / WebAuthn PRF
export const GET_RAW_KEY = 'GET_RAW_KEY';
export const GET_BIOMETRIC = 'GET_BIOMETRIC';
export const SET_BIOMETRIC = 'SET_BIOMETRIC';
export const CLEAR_BIOMETRIC = 'CLEAR_BIOMETRIC';
export const UNLOCK_WITH_KEY = 'UNLOCK_WITH_KEY';

// Suggestions and vault health
export const SUGGEST_REQUEST = 'SUGGEST_REQUEST';
export const AUDIT = 'AUDIT';
