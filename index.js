// Scenario Sprites — per-character expression sprites for scenario-style cards
// Detects which lorebook character is active in each message and switches
// the sprite folder so the built-in expressions system shows the right character.

import { eventSource, event_types, saveSettingsDebounced, this_chid, characters } from '../../../../script.js';
import { getContext, extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { executeSlashCommandsOnChatInput } from '../../../slash-commands.js';
import { getCharaFilename } from '../../../utils.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '../../../slash-commands/SlashCommandArgument.js';

// ═══════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════

const EXTENSION_NAME = 'Scenario Sprites';
const LOG_PREFIX = '[ScenarioSprites]';

/** Resolve the extension folder name from the module URL */
const EXTENSION_FOLDER = (() => {
    try {
        const url = import.meta.url;
        const match = url.match(/\/extensions\/third-party\/([^/]+)\//);
        if (match) return match[1];
    } catch { /* ignore */ }
    return 'SillyTavern-ScenarioSprites';
})();
const TEMPLATE_NAMESPACE = `third-party/${EXTENSION_FOLDER}`;

/** Detection type priorities — higher = stronger signal */
const PRIORITY = {
    speaker: 6,
    attribution: 5,
    action: 4,
    possessive: 3.5,
    pronoun: 3,
    mention: 1,
    vocative: 0.5,
};

/** Priority multiplier for scoring (scales type priority relative to distance) */
const PRIORITY_MULTIPLIER = 100;

/** Distance normalization range — distance is scaled to 0..this value */
const DISTANCE_RANGE = 100;

/**
 * Japanese/CJK honorific particles that may be appended to names.
 * Used to build an optional suffix in name regex patterns.
 */
const HONORIFIC_PARTICLES = [
    'san', 'sama', 'chan', 'kun', 'dono', 'sensei', 'senpai', 'kohai',
    'shi', 'tan', 'chi', 'nee', 'nii',
    // Korean
    '씨',
    // Japanese kana/kanji
    'さま', 'さん', 'くん', 'ちゃん', '様', '殿', '先輩',
];

/** Regex fragment for optional honorific suffix */
const HONORIFIC_SUFFIX = (() => {
    const escaped = HONORIFIC_PARTICLES.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return `(?:[\\s-]*(?:${escaped.join('|')}))?`;
})();

/**
 * Regex patterns to strip tracker/director metadata before detection.
 * White Lotus extension and preset embed these in msg.mes — they contain
 * off-screen info that would confuse character detection scoring.
 */
const TRACKER_STRIP_PATTERNS = [
    /\[LOTUS\|[\s\S]*?\[\/LOTUS\]/gi,
    /\[TEMPORAL\|[\s\S]*?\[\/TEMPORAL\]/gi,
    /\[RPS\|[\s\S]*?\[\/RPS\]/gi,
    /<!--\s*\[SLATE\][\s\S]*?\[\/SLATE\]\s*-->/gi,
    /<!--WL_TRACKER_START-->[\s\S]*?<!--WL_TRACKER_END-->/gi,
];

/**
 * Strip tracker/director metadata from message text.
 * @param {string} text
 * @returns {string} Cleaned text
 */
function stripTrackerContent(text) {
    if (!text) return text;
    let result = text;
    for (const pattern of TRACKER_STRIP_PATTERNS) {
        result = result.replace(pattern, '');
    }
    return result.trim();
}

/**
 * Attribution verbs — words that signal "Name said/whispered/etc."
 * Past tense and third-person present covers most novel-style writing.
 */
const ATTRIBUTION_VERBS = [
    'said', 'says', 'say', 'asked', 'asks', 'ask', 'replied', 'replies', 'reply',
    'answered', 'answers', 'answer', 'called', 'calls', 'call', 'added', 'adds', 'add',
    'continued', 'continues', 'continue', 'began', 'begins', 'begin',
    'whispered', 'whispers', 'murmured', 'murmurs', 'muttered', 'mutters',
    'mumbled', 'mumbles', 'breathed', 'breathes', 'hissed', 'hisses',
    'growled', 'growls', 'snarled', 'snarls', 'barked', 'barks', 'snapped', 'snaps',
    'stammered', 'stammers', 'stuttered', 'stutters', 'drawled', 'drawls',
    'purred', 'purrs', 'crooned', 'croons', 'rasped', 'rasps', 'slurred', 'slurs',
    'shouted', 'shouts', 'yelled', 'yells', 'screamed', 'screams',
    'shrieked', 'shrieks', 'cried', 'cries', 'exclaimed', 'exclaims', 'bellowed', 'bellows',
    'laughed', 'laughs', 'chuckled', 'chuckles', 'giggled', 'giggles',
    'snickered', 'snickers', 'scoffed', 'scoffs', 'sighed', 'sighs',
    'groaned', 'groans', 'moaned', 'moans', 'whined', 'whines',
    'sobbed', 'sobs', 'wailed', 'wails', 'huffed', 'huffs', 'snorted', 'snorts',
    'demanded', 'demands', 'insisted', 'insists', 'urged', 'urges',
    'pleaded', 'pleads', 'begged', 'begs', 'warned', 'warns',
    'threatened', 'threatens', 'promised', 'promises', 'suggested', 'suggests',
    'offered', 'offers', 'proposed', 'proposes',
    'explained', 'explains', 'remarked', 'remarks', 'observed', 'observes',
    'noted', 'notes', 'commented', 'comments', 'declared', 'declares',
    'announced', 'announces', 'admitted', 'admits', 'confessed', 'confesses',
    'revealed', 'reveals', 'protested', 'protests', 'objected', 'objects',
    'agreed', 'agrees', 'conceded', 'concedes', 'acknowledged', 'acknowledges',
    'interrupted', 'interrupts', 'interjected', 'interjects', 'corrected', 'corrects',
    'countered', 'counters', 'retorted', 'retorts', 'quipped', 'quips',
    'teased', 'teases', 'mused', 'muses', 'wondered', 'wonders',
    'pondered', 'ponders', 'recalled', 'recalls', 'recounted', 'recounts',
    'repeated', 'repeats', 'echoed', 'echoes', 'relented', 'relents',
];

/**
 * Action verbs — words that signal "Name walked/smiled/etc."
 * Physical actions, gestures, expressions.
 */
const ACTION_VERBS = [
    'walked', 'walks', 'stepped', 'steps', 'moved', 'moves', 'turned', 'turns',
    'approached', 'approaches', 'retreated', 'retreats', 'entered', 'enters',
    'left', 'leaves', 'followed', 'follows', 'ran', 'runs', 'rushed', 'rushes',
    'hurried', 'hurries', 'stumbled', 'stumbles', 'staggered', 'staggers',
    'paced', 'paces', 'strode', 'strides', 'sprinted', 'sprints', 'crawled', 'crawls',
    'stood', 'stands', 'sat', 'sits', 'knelt', 'kneels', 'crouched', 'crouches',
    'leaned', 'leans', 'slouched', 'slouches', 'straightened', 'straightens',
    'rose', 'rises', 'fell', 'falls', 'collapsed', 'collapses',
    'reached', 'reaches', 'grabbed', 'grabs', 'held', 'holds', 'dropped', 'drops',
    'placed', 'places', 'set', 'sets', 'pulled', 'pulls', 'pushed', 'pushes',
    'pointed', 'points', 'waved', 'waves', 'gestured', 'gestures',
    'crossed', 'crosses', 'folded', 'folds', 'clenched', 'clenches',
    'rubbed', 'rubs', 'touched', 'touches', 'tapped', 'taps', 'squeezed', 'squeezes',
    'lifted', 'lifts', 'raised', 'raises', 'lowered', 'lowers',
    'caught', 'catches', 'tossed', 'tosses', 'threw', 'throws',
    'slammed', 'slams', 'clutched', 'clutches',
    'looked', 'looks', 'glanced', 'glances', 'stared', 'stares', 'gazed', 'gazes',
    'watched', 'watches', 'blinked', 'blinks', 'winced', 'winces',
    'flinched', 'flinches', 'squinted', 'squints',
    'nodded', 'nods', 'shook', 'shakes', 'tilted', 'tilts', 'cocked', 'cocks',
    'smiled', 'smiles', 'grinned', 'grins', 'frowned', 'frowns',
    'scowled', 'scowls', 'smirked', 'smirks', 'grimaced', 'grimaces',
    'beamed', 'beams', 'pouted', 'pouts', 'sneered', 'sneers', 'glared', 'glares',
    'shrugged', 'shrugs', 'trembled', 'trembles', 'shivered', 'shivers',
    'tensed', 'tenses', 'relaxed', 'relaxes', 'froze', 'freezes',
    'flushed', 'flushes', 'swallowed', 'swallows', 'exhaled', 'exhales',
    'inhaled', 'inhales', 'paused', 'pauses', 'hesitated', 'hesitates',
    'stiffened', 'stiffens', 'shifted', 'shifts', 'fidgeted', 'fidgets',
    'appeared', 'appears', 'disappeared', 'disappears',
];

/** Pronouns for subject tracking */
const DEFAULT_PRONOUNS = {
    'he':    { type: 'subject',    gender: 'male' },
    'him':   { type: 'object',     gender: 'male' },
    'his':   { type: 'possessive', gender: 'male' },
    'she':   { type: 'subject',    gender: 'female' },
    'her':   { type: 'object',     gender: 'female' },
    'hers':  { type: 'possessive', gender: 'female' },
    'they':  { type: 'subject',    gender: 'neutral' },
    'them':  { type: 'object',     gender: 'neutral' },
    'their': { type: 'possessive', gender: 'neutral' },
};

// ═══════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════

let currentActiveCharacter = null;
let lastProcessedMessage = null;

/**
 * Cross-message pronoun context: the name of the last character detected
 * in a previous message. Used as fallback when a pronoun at the start of
 * a message has no same-message antecedent.
 */
let lastDetectedCharacterName = null;

// ═══════════════════════════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════════════════════════

const DEFAULT_SETTINGS = {
    enabled: true,
    profiles: {},
    debugMode: false,
};

function ensureSettings() {
    if (!extension_settings.scenarioSprites) {
        extension_settings.scenarioSprites = { ...DEFAULT_SETTINGS };
    }
    const s = extension_settings.scenarioSprites;
    if (s.profiles === undefined) s.profiles = {};
    if (s.enabled === undefined) s.enabled = true;
    if (s.debugMode === undefined) s.debugMode = false;
    return s;
}

function getCardKey() {
    // Method 1: getCharaFilename (standard approach)
    try {
        const filename = getCharaFilename();
        if (filename) {
            console.debug(`${LOG_PREFIX} Card key via getCharaFilename: "${filename}"`);
            return filename;
        }
    } catch (err) {
        console.warn(`${LOG_PREFIX} getCharaFilename() failed:`, err);
    }

    // Method 2: fall back to context API
    try {
        const context = getContext();
        if (context.characterId !== undefined && context.characters?.[context.characterId]) {
            const char = context.characters[context.characterId];
            const key = char.avatar?.replace(/\.[^/.]+$/, '') || char.name;
            if (key) {
                console.debug(`${LOG_PREFIX} Card key via context fallback: "${key}"`);
                return key;
            }
        }
    } catch (err) {
        console.warn(`${LOG_PREFIX} Context fallback failed:`, err);
    }

    // Method 3: use this_chid directly
    if (this_chid !== undefined && characters?.[this_chid]) {
        const char = characters[this_chid];
        const key = char.avatar?.replace(/\.[^/.]+$/, '') || char.name;
        if (key) {
            console.debug(`${LOG_PREFIX} Card key via this_chid fallback: "${key}"`);
            return key;
        }
    }

    console.warn(`${LOG_PREFIX} Could not determine card key — no character selected?`);
    return null;
}

function getCardProfile() {
    const settings = ensureSettings();
    const key = getCardKey();
    if (!key) return null;
    if (!settings.profiles[key]) {
        settings.profiles[key] = { characters: [] };
    }
    return settings.profiles[key];
}

function getCharacterList() {
    const profile = getCardProfile();
    return profile ? profile.characters : [];
}

function saveAndUpdate() {
    saveSettingsDebounced();
    renderCharacterList();
}

// ═══════════════════════════════════════════════════════════════════════
// DETECTION ENGINE
// ═══════════════════════════════════════════════════════════════════════

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a regex alternation that matches a character's name OR any of
 * their aliases, each with an optional honorific suffix.
 * Returns the raw pattern body (no flags, no outer group).
 */
function buildNameAlternation(char) {
    const names = [char.name];
    if (Array.isArray(char.aliases)) {
        for (const alias of char.aliases) {
            const trimmed = alias.trim();
            if (trimmed && trimmed.toLowerCase() !== char.name.toLowerCase()) {
                names.push(trimmed);
            }
        }
    }
    const parts = names.map(n => escapeRegex(n) + HONORIFIC_SUFFIX);
    return parts.length === 1 ? parts[0] : `(?:${parts.join('|')})`;
}

function getQuoteRanges(text) {
    const ranges = [];
    const patterns = [
        /\u201c[^\u201d]*\u201d/g,
        /\u2018[^\u2019]*\u2019/g,
        /"[^"]*"/g,
        /\u00ab[^\u00bb]*\u00bb/g,
        /\u300c[^\u300d]*\u300d/g,
    ];
    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(text)) !== null) {
            ranges.push({ start: match.index, end: match.index + match[0].length });
        }
    }
    ranges.sort((a, b) => a.start - b.start);
    return ranges;
}

function isInsideQuotes(index, quoteRanges) {
    for (const range of quoteRanges) {
        if (index >= range.start && index < range.end) return true;
        if (range.start > index) break;
    }
    return false;
}

function classifyByFollowingVerb(text, nameEnd) {
    const window = text.slice(nameEnd, nameEnd + 80);
    const words = window.match(/\S+/g);
    if (!words) return null;
    const limit = Math.min(words.length, 5);
    for (let i = 0; i < limit; i++) {
        const word = words[i].toLowerCase().replace(/[^a-z]/g, '');
        if (!word) continue;
        if (ATTRIBUTION_VERBS.includes(word)) return 'attribution';
        if (ACTION_VERBS.includes(word)) return 'action';
    }
    return null;
}

/**
 * Check for inverted attribution: "dialogue," verb Name
 * Scans the window between a closing quote and the name for attribution verbs.
 * Returns 'attribution' if found, null otherwise.
 */
function classifyByInvertedAttribution(text, nameStart) {
    // Look back up to 60 chars for a closing quote followed by optional comma/space + verb
    const windowStart = Math.max(0, nameStart - 60);
    const window = text.slice(windowStart, nameStart);

    // Pattern: closing quote, optional comma, whitespace, then words before the name
    const quoteEnd = window.match(/[\u201d\u2019"']\s*,?\s+(.+)$/);
    if (!quoteEnd) return null;

    // Check the words between the quote close and the name for attribution verbs
    const between = quoteEnd[1].trim();
    const words = between.match(/\S+/g);
    if (!words) return null;

    for (const w of words) {
        const word = w.toLowerCase().replace(/[^a-z]/g, '');
        if (word && ATTRIBUTION_VERBS.includes(word)) return 'attribution';
    }
    return null;
}

function classifyByPrecedingContext(text, nameStart) {
    const window = text.slice(Math.max(0, nameStart - 40), nameStart);
    if (/[\u201d\u2019"']\s*,?\s*$/.test(window)) {
        return 'attribution_candidate';
    }
    return null;
}

/**
 * Resolve a pronoun to a character.
 * Uses same-message name matches as primary antecedent, with optional
 * cross-message fallback from previousCharacterName.
 */
function resolvePronoun(pronoun, pronounIndex, nameMatches, characterList, previousCharacterName) {
    const pronounInfo = DEFAULT_PRONOUNS[pronoun.toLowerCase()];
    if (!pronounInfo) return null;

    const genderCandidates = characterList.filter(char => {
        if (!char.pronouns || char.pronouns.length === 0) return true;
        return char.pronouns.some(p => {
            const pi = DEFAULT_PRONOUNS[p.toLowerCase()];
            return pi && pi.gender === pronounInfo.gender;
        });
    });
    if (genderCandidates.length === 0) return null;
    if (genderCandidates.length === 1) return genderCandidates[0];

    // Try same-message antecedent: most recent named character before the pronoun
    let lastMatch = null;
    for (const nm of nameMatches) {
        if (nm.index < pronounIndex) {
            if (genderCandidates.some(c => c.name === nm.character.name)) {
                lastMatch = nm;
            }
        }
    }
    if (lastMatch) return lastMatch.character;

    // Cross-message fallback: use the last detected character from the previous message
    if (previousCharacterName) {
        const crossRef = genderCandidates.find(
            c => c.name.toLowerCase() === previousCharacterName.toLowerCase(),
        );
        if (crossRef) return crossRef;
    }

    return genderCandidates[0];
}

/**
 * Extract the last paragraph from the text.
 * Splits on double-newline or single-newline boundaries, returns the
 * last non-empty segment.
 */
function getLastParagraph(text) {
    // Try double-newline split first (standard paragraph breaks)
    let paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
    if (paragraphs.length > 1) {
        return paragraphs[paragraphs.length - 1];
    }
    // Fall back to single-newline
    paragraphs = text.split(/\n/).map(p => p.trim()).filter(Boolean);
    if (paragraphs.length > 1) {
        return paragraphs[paragraphs.length - 1];
    }
    return text;
}

/**
 * Core detection: find all character signals in a text and score them.
 * Returns { character, allMatches } or null if no matches found.
 */
function runDetection(text, characterList, previousCharacterName, debugMode) {
    if (!text || !characterList || characterList.length === 0) return null;

    const quoteRanges = getQuoteRanges(text);
    const textLength = text.length;

    // ── Phase 1: Speaker tag detection ──────────────────────────────
    // Matches "Name:" at the start of a line — the strongest signal.
    const speakerMatches = [];
    for (const char of characterList) {
        const alternation = buildNameAlternation(char);
        const speakerRegex = new RegExp(`(?:^|[\\r\\n]+)\\s*(${alternation})\\s*:`, 'gi');
        let match;
        while ((match = speakerRegex.exec(text)) !== null) {
            const nameStr = match[1];
            const index = match.index + match[0].indexOf(nameStr);
            speakerMatches.push({
                character: char, index, length: nameStr.length,
                type: 'speaker', insideQuotes: false,
            });
        }
    }

    // ── Phase 2: Explicit name matches ──────────────────────────────
    const nameMatches = [];
    for (const char of characterList) {
        const alternation = buildNameAlternation(char);
        const nameRegex = new RegExp(`\\b${alternation}\\b`, 'gi');
        let match;
        while ((match = nameRegex.exec(text)) !== null) {
            const index = match.index;
            const matchLength = match[0].length;
            const insideQuotes = isInsideQuotes(index, quoteRanges);
            let type = insideQuotes ? 'vocative' : 'mention';

            if (!insideQuotes) {
                // Check for possessive: Name's
                const afterName = text.slice(index + matchLength, index + matchLength + 3);
                if (/^[''\u2019]s\b/.test(afterName)) {
                    type = 'possessive';
                } else {
                    // Check following verb
                    const verbType = classifyByFollowingVerb(text, index + matchLength);
                    if (verbType) {
                        type = verbType;
                    } else {
                        // Check inverted attribution: "dialogue," said Name
                        const invertedType = classifyByInvertedAttribution(text, index);
                        if (invertedType) {
                            type = invertedType;
                        } else {
                            // Check preceding quote context: "dialogue," Name verb
                            const preceding = classifyByPrecedingContext(text, index);
                            if (preceding === 'attribution_candidate') {
                                const afterVerb = classifyByFollowingVerb(text, index + matchLength);
                                type = afterVerb || 'attribution';
                            }
                        }
                    }
                }
            }

            nameMatches.push({ character: char, index, length: matchLength, type, insideQuotes });
        }
    }

    nameMatches.sort((a, b) => a.index - b.index);

    // ── Phase 3: Pronoun matches ────────────────────────────────────
    const pronounMatches = [];
    const pronounSubjects = Object.keys(DEFAULT_PRONOUNS)
        .filter(p => DEFAULT_PRONOUNS[p].type === 'subject');
    const pronounPattern = new RegExp(`\\b(${pronounSubjects.join('|')})\\b`, 'gi');

    let pronounMatch;
    while ((pronounMatch = pronounPattern.exec(text)) !== null) {
        const index = pronounMatch.index;
        const pronoun = pronounMatch[1].toLowerCase();
        const insideQuotes = isInsideQuotes(index, quoteRanges);
        if (insideQuotes) continue;

        const followingVerb = classifyByFollowingVerb(text, index + pronounMatch[0].length);
        if (!followingVerb) continue;

        const resolved = resolvePronoun(pronoun, index, nameMatches, characterList, previousCharacterName);
        if (!resolved) continue;

        pronounMatches.push({
            character: resolved, index, length: pronounMatch[0].length,
            type: 'pronoun', insideQuotes: false, resolvedFrom: pronoun,
        });
    }

    // ── Phase 4: Score all matches ──────────────────────────────────
    const allMatches = [...speakerMatches, ...nameMatches, ...pronounMatches];
    if (allMatches.length === 0) return null;

    let bestMatch = null;
    let bestScore = -Infinity;

    for (const m of allMatches) {
        const priority = PRIORITY[m.type] || 0;
        // Normalize distance to 0..DISTANCE_RANGE so priority always dominates
        const distanceFromEnd = textLength - m.index;
        const normalizedDistance = textLength > 0
            ? (distanceFromEnd / textLength) * DISTANCE_RANGE
            : 0;
        const score = (priority * PRIORITY_MULTIPLIER) - normalizedDistance;

        if (debugMode) {
            console.debug(
                `${LOG_PREFIX} Match: "${m.character.name}" type=${m.type} pos=${m.index} ` +
                `dist=${distanceFromEnd} normDist=${normalizedDistance.toFixed(1)} score=${score.toFixed(1)}`,
                m.resolvedFrom ? `(from pronoun "${m.resolvedFrom}")` : '',
            );
        }

        if (score > bestScore) {
            bestScore = score;
            bestMatch = m;
        }
    }

    if (debugMode && bestMatch) {
        console.log(`${LOG_PREFIX} Winner: "${bestMatch.character.name}" (type=${bestMatch.type}, score=${bestScore.toFixed(1)})`);
    }

    return bestMatch ? { character: bestMatch.character, allMatches } : null;
}

/**
 * Main detection entry point.
 * Tries the last paragraph first for a clean signal, then falls back
 * to the full message text.
 */
function detectActiveCharacter(text, characterList, previousCharacterName) {
    if (!text || !characterList || characterList.length === 0) return null;

    const settings = ensureSettings();
    const debugMode = settings.debugMode;

    // Strategy: try last paragraph first — it's where the most recent
    // character action usually lives
    const lastParagraph = getLastParagraph(text);
    if (lastParagraph !== text && lastParagraph.length > 10) {
        if (debugMode) {
            console.log(`${LOG_PREFIX} ── Last-paragraph pass (${lastParagraph.length} chars) ──`);
        }
        const result = runDetection(lastParagraph, characterList, previousCharacterName, debugMode);
        if (result) return result.character;
    }

    // Full-message fallback
    if (debugMode && lastParagraph !== text) {
        console.log(`${LOG_PREFIX} ── Full-message fallback (${text.length} chars) ──`);
    }
    const result = runDetection(text, characterList, previousCharacterName, debugMode);
    return result ? result.character : null;
}

// ═══════════════════════════════════════════════════════════════════════
// SPRITE SWITCHING
// ═══════════════════════════════════════════════════════════════════════

async function switchToCharacter(character) {
    if (!character || !character.folder) return;
    const folder = character.folder.trim();
    if (!folder) return;
    if (currentActiveCharacter && currentActiveCharacter.name === character.name) return;

    const prevName = currentActiveCharacter?.name || 'none';
    currentActiveCharacter = character;

    try {
        await executeSlashCommandsOnChatInput(`/costume ${folder}`);
        console.log(`${LOG_PREFIX} Switched: ${prevName} → ${character.name} (folder: ${folder})`);
        updateStatusDisplay(character.name);
    } catch (err) {
        console.error(`${LOG_PREFIX} Failed to switch costume to "${folder}":`, err);
    }
}

function getLastCharacterMessage() {
    const context = getContext();
    if (!context.chat || context.chat.length === 0) return null;
    for (let i = context.chat.length - 1; i >= 0; i--) {
        const msg = context.chat[i];
        if (!msg.is_user && !msg.is_system) return msg;
    }
    return null;
}

async function processLatestMessage() {
    const settings = ensureSettings();
    if (!settings.enabled) return;
    const characterList = getCharacterList();
    if (characterList.length === 0) return;
    const message = getLastCharacterMessage();
    if (!message || !message.mes) return;

    const messageKey = `${message.mes.length}-${message.mes.slice(-50)}`;
    if (messageKey === lastProcessedMessage) return;
    lastProcessedMessage = messageKey;

    // Strip tracker/director metadata before detection — these contain
    // off-screen info that would skew character scoring
    const cleanText = stripTrackerContent(message.mes);
    if (!cleanText) return;

    const detected = detectActiveCharacter(cleanText, characterList, lastDetectedCharacterName);
    if (detected) {
        // Update cross-message pronoun context
        lastDetectedCharacterName = detected.name;
        await switchToCharacter(detected);
    }
}

function onChatChanged() {
    currentActiveCharacter = null;
    lastProcessedMessage = null;
    lastDetectedCharacterName = null;
    renderCharacterList();
    setTimeout(() => processLatestMessage(), 500);
}

// ═══════════════════════════════════════════════════════════════════════
// SLASH COMMANDS
// ═══════════════════════════════════════════════════════════════════════

function registerCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ss-focus',
        callback: async (_, name) => {
            if (!name || typeof name !== 'string') {
                toastr.warning('Provide a character name. Usage: /ss-focus Alice');
                return '';
            }
            const characterList = getCharacterList();
            const nameLower = name.trim().toLowerCase();
            const target = characterList.find(
                c => c.name.toLowerCase() === nameLower
                    || (c.aliases || []).some(a => a.toLowerCase() === nameLower),
            );
            if (!target) {
                toastr.warning(`Character "${name}" not found in Scenario Sprites list.`);
                return '';
            }
            currentActiveCharacter = null;
            await switchToCharacter(target);
            toastr.success(`Focused on ${target.name}`);
            return target.name;
        },
        unnamedArgumentList: [
            new SlashCommandArgument('character name', [ARGUMENT_TYPE.STRING], true),
        ],
        helpString: 'Manually switch the Scenario Sprites display to a specific character.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ss-detect',
        callback: async () => {
            const characterList = getCharacterList();
            if (characterList.length === 0) {
                toastr.info('No characters configured in Scenario Sprites.');
                return '';
            }
            const message = getLastCharacterMessage();
            if (!message || !message.mes) {
                toastr.info('No character message found.');
                return '';
            }
            const settings = ensureSettings();
            const wasDebug = settings.debugMode;
            settings.debugMode = true;
            const cleanText = stripTrackerContent(message.mes);
            const detected = detectActiveCharacter(cleanText || message.mes, characterList, lastDetectedCharacterName);
            settings.debugMode = wasDebug;

            if (detected) {
                toastr.success(`Detected: ${detected.name}`);
                return detected.name;
            } else {
                toastr.info('No character detected in the latest message.');
                return '';
            }
        },
        helpString: 'Run Scenario Sprites detection on the latest message and report results (logs scoring to console).',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ss-clear',
        callback: async () => {
            currentActiveCharacter = null;
            lastProcessedMessage = null;
            lastDetectedCharacterName = null;
            try {
                await executeSlashCommandsOnChatInput('/costume');
                toastr.info('Sprite override cleared.');
            } catch (err) {
                console.error(`${LOG_PREFIX} Failed to clear costume:`, err);
            }
            updateStatusDisplay(null);
            return '';
        },
        helpString: 'Clear the Scenario Sprites costume override and reset detection state.',
    }));
}

// ═══════════════════════════════════════════════════════════════════════
// UI
// ═══════════════════════════════════════════════════════════════════════

function updateStatusDisplay(characterName) {
    const el = document.getElementById('ss-current-character');
    if (el) {
        el.textContent = characterName || 'None detected';
        el.classList.toggle('ss-active', !!characterName);
    }
}

function renderCharacterList() {
    const container = document.getElementById('ss-character-list');
    if (!container) return;

    const characterList = getCharacterList();
    container.innerHTML = '';

    if (characterList.length === 0) {
        container.innerHTML = '<div class="ss-empty-state">No characters added yet. Add character names that match your lorebook characters and have sprite folders set up.</div>';
        return;
    }

    for (let i = 0; i < characterList.length; i++) {
        const char = characterList[i];
        // Migrate old data: ensure aliases array exists
        if (!Array.isArray(char.aliases)) char.aliases = [];

        const card = document.createElement('div');
        card.className = 'ss-character-card';

        const isActive = currentActiveCharacter?.name === char.name;
        if (isActive) card.classList.add('ss-card-active');

        card.innerHTML = `
            <div class="ss-card-header">
                <span class="ss-card-name">${char.name}</span>
                ${isActive ? '<span class="ss-card-badge">Active</span>' : ''}
                <div class="ss-card-actions">
                    <button class="ss-btn-icon ss-btn-focus menu_button" title="Focus on this character">
                        <i class="fa-solid fa-crosshairs"></i>
                    </button>
                    <button class="ss-btn-icon ss-btn-remove menu_button" title="Remove character">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </div>
            <div class="ss-card-details">
                <div class="ss-detail-row">
                    <label>Sprite Folder</label>
                    <input type="text" class="ss-folder-input text_pole" value="${char.folder}" data-index="${i}" placeholder="Same as name" />
                </div>
                <div class="ss-detail-row">
                    <label>Aliases</label>
                    <input type="text" class="ss-aliases-input text_pole" value="${(char.aliases || []).join(', ')}" data-index="${i}" placeholder="e.g. Liz, Beth, Lizzie" />
                </div>
                <div class="ss-detail-row">
                    <label>Pronouns</label>
                    <input type="text" class="ss-pronouns-input text_pole" value="${(char.pronouns || []).join(', ')}" data-index="${i}" placeholder="e.g. she, her" />
                </div>
            </div>
        `;

        card.querySelector('.ss-btn-remove').addEventListener('click', () => {
            characterList.splice(i, 1);
            saveAndUpdate();
        });

        card.querySelector('.ss-btn-focus').addEventListener('click', async () => {
            currentActiveCharacter = null;
            await switchToCharacter(char);
        });

        card.querySelector('.ss-folder-input').addEventListener('change', (e) => {
            characterList[i].folder = e.target.value.trim() || char.name;
            saveSettingsDebounced();
        });

        card.querySelector('.ss-aliases-input').addEventListener('change', (e) => {
            const raw = e.target.value;
            characterList[i].aliases = raw
                .split(/[,;]+/)
                .map(a => a.trim())
                .filter(Boolean);
            saveSettingsDebounced();
        });

        card.querySelector('.ss-pronouns-input').addEventListener('change', (e) => {
            const raw = e.target.value;
            characterList[i].pronouns = raw
                .split(/[,\s]+/)
                .map(p => p.trim().toLowerCase())
                .filter(Boolean);
            saveSettingsDebounced();
        });

        container.appendChild(card);
    }
}

async function renderSettingsPanel() {
    const settings = ensureSettings();
    const html = await renderExtensionTemplateAsync(TEMPLATE_NAMESPACE, 'settings');

    const container = document.getElementById('extensions_settings2');
    if (!container) return;

    const wrapper = document.createElement('div');
    wrapper.innerHTML = html;
    container.appendChild(wrapper);

    const enableToggle = document.getElementById('ss-enabled');
    if (enableToggle) {
        enableToggle.checked = settings.enabled;
        enableToggle.addEventListener('change', () => {
            settings.enabled = enableToggle.checked;
            saveSettingsDebounced();
        });
    }

    const debugToggle = document.getElementById('ss-debug');
    if (debugToggle) {
        debugToggle.checked = settings.debugMode;
        debugToggle.addEventListener('change', () => {
            settings.debugMode = debugToggle.checked;
            saveSettingsDebounced();
        });
    }

    const addBtn = document.getElementById('ss-add-character');
    const nameInput = document.getElementById('ss-new-name');
    if (addBtn && nameInput) {
        const doAdd = () => {
            const name = nameInput.value.trim();
            if (!name) {
                toastr.warning('Enter a character name.');
                return;
            }
            const cardKey = getCardKey();
            if (!cardKey) {
                toastr.error('No character card detected. Open a scenario card first.');
                console.error(`${LOG_PREFIX} doAdd failed: getCardKey() returned null. this_chid=${this_chid}`);
                return;
            }
            const characterList = getCharacterList();
            if (characterList.some(c => c.name.toLowerCase() === name.toLowerCase())) {
                toastr.warning(`"${name}" is already in the list.`);
                return;
            }
            characterList.push({
                name: name,
                folder: name,
                aliases: [],
                pronouns: [],
            });
            nameInput.value = '';
            saveAndUpdate();
            toastr.success(`Added "${name}". Set up a sprite folder named "${name}" if you haven't already.`);
        };

        addBtn.addEventListener('click', doAdd);
        nameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                doAdd();
            }
        });
    }

    renderCharacterList();
}

// ═══════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════

jQuery(async () => {
    ensureSettings();
    await renderSettingsPanel();
    registerCommands();

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => {
        setTimeout(() => processLatestMessage(), 300);
    });

    eventSource.on(event_types.MESSAGE_SWIPED, () => {
        lastProcessedMessage = null;
        setTimeout(() => processLatestMessage(), 300);
    });

    eventSource.on(event_types.CHAT_CHANGED, () => {
        onChatChanged();
    });

    console.log(`${LOG_PREFIX} Extension loaded (v0.2.0).`);
});
