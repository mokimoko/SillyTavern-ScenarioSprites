# Scenario Sprites

A [SillyTavern](https://github.com/SillyTavern/SillyTavern) extension that enables per-character expression sprites in scenario-style cards — the kind where characters are defined in lorebooks rather than individual character cards.

Inspired by [Expressions Plus](https://github.com/Tyranomaster/expressions-plus). I didn't need all the fancy stuff; all this does is let you use sprite folders for multi-character cards, so each character you assign can use expressions. It's not perfect and doesn't always get it right, but I've had fun with it.

## How It Works

The extension reads each AI message, detects which character is "active" (speaking or performing actions), and switches the displayed sprite folder to that character using SillyTavern's `/costume` command. Detection uses a weighted scoring system that looks for signals like:

- **Speaker tags** — `Alice:` at the start of a line (strongest signal)
- **Attribution** — `Alice said`, `whispered Alice`
- **Actions** — `Alice walked`, `Alice smiled`
- **Possessives** — `Alice's eyes`
- **Pronouns** — `She sighed` (resolved by gender + context)
- **Mentions** — `Alice` appearing in narration
- **Vocatives** — `"Hello, Alice"` inside dialogue (weakest signal)

When multiple characters appear in a message, the extension prioritizes signal type first, then recency — so the character doing the most important thing near the end of the message usually wins.

## Installation

Use SillyTavern's built-in extension installer:

1. Open **Extensions** → **Install Extension**
2. Paste this URL:
   ```
   https://github.com/mokimoko/SillyTavern-ScenarioSprites
   ```
3. Click **Install** and reload if prompted

## Setup

1. **Create sprite folders** — In your SillyTavern `public/characters/` sprites directory, create a folder for each character (e.g. `Alice`, `Bob`). Place expression images inside (`joy.png`, `sadness.png`, etc.), same as you would for any character's sprites.

2. **Open your scenario card** — The extension stores character lists per card, so you need to have the card active.

3. **Add characters** — In the extension settings panel, type each character's name and click **Add**. The sprite folder defaults to the character name but can be customized.

4. **Set aliases** *(optional)* — Comma-separated alternate names, nicknames, or shortened forms. For example, if the character is "Elizabeth," you might add `Liz, Beth, Lizzie`. Japanese honorifics like `-san`, `-chan`, etc. are handled automatically.

5. **Set pronouns** — Helps the extension track characters through pronoun references like "she smiled" or "he turned away." Pronouns carry across messages too — if the last message detected Alice, and the next opens with "She sighed," it resolves to Alice.

## Slash Commands

| Command | Description |
|---------|-------------|
| `/ss-focus Name` | Manually switch to a character's sprite folder |
| `/ss-detect` | Test detection on the latest message (logs scoring to console) |
| `/ss-clear` | Clear the sprite override and reset detection state |

## Notes

- Works best with narrative-style writing where characters are named in prose
- The **Debug mode** toggle in settings logs detection scoring to the browser console — useful for understanding why a particular character was or wasn't detected
- Character configurations are stored per card, so different scenario cards can have different character lists

## Credits

Inspired by [Expressions Plus](https://github.com/Tyranomaster/expressions-plus) by Tyranomaster
