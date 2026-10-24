# Changelog

Full version history for Live NBA Scores, newest first. The [README](README.md) lists the three most recent updates.

**v1.1.2.0**
- Fixed: "today" is now read in Eastern time, which is how ESPN dates its games. Outside the US the keys could ask for tomorrow's slate while tonight's games were still on. The day now changes at 5:00 AM Eastern (2:00 AM Pacific), so late games and their finals stay on the keys overnight everywhere
- If ESPN stops responding for a moment, keys keep showing the last scores with a small amber dot instead of "Err" (after 10 minutes without an update they show "Err")
- One odd game in ESPN's data no longer turns a whole Scoreboard to "Err"
- Requires Stream Deck 7.1 or later

**v1.1.1.0**
- Pregame keys are easier to read: the teams stack on two lines (away team on top, "@ home" below, with a small "@") and the day and time get their own lines. On game day the day line goes away and the start time is shown larger. Same on team keys and Scoreboard keys
- Games a week or more out show the date on the day line ("Sat 10/24"), with the time underneath
- Off-day keys show your team's next game the same way: the "Next Game" label is gone, and the day line reads the weekday ("Thursday"), or the date when it's a week or more away
- The Scoreboard's next-game-day keys (no games today) use the same layout
- Long G League names (RCITY, VALLEY) shrink just enough to fit

**v1.1.0.0**
- New: **Live NBA Scoreboard** action — drag it onto as many keys as you like and they fill with today's games, one game per key, in tip-off order. Pick the league for each board: **NBA** (up to 15 keys), **WNBA** (up to 7) or **G League** (up to 15)
- Same keys as the team action: lead-change and tie flashes with their cards (NY / UP 3, TIED / 88-88), the red crunch-time clock, and fireworks at the final
- Each board remembers its own settings, so an NBA page and a G League page work, and boards with different settings can share a page; give each board its own background color to tell them apart
- Fill top-to-bottom or left-to-right, and optionally send finished games to the end (recommended on smaller Stream Decks). More games than keys: the last key shows "+N more"; extra keys show "No Game". Both open ESPN's scoreboard for that league
- The board moves to the next day at 2:00 AM, same as the team keys. On a day with no games, it shows the next game day's schedule with the day on each key
- Final games now open ESPN's box score instead of Gamecast, on both actions
- Neutral-site games (international games, the NBA Cup final) show "vs" instead of "@", on both actions

**v1.0.1.0**
- Lead-change flash is now 5 solid blinks of the new leader's color with no text, then a 3-second card with the team and margin (e.g. NY / UP 3)
- New: when a game gets tied up, the key blinks in the tying team's color and shows a TIED / 88-88 card

**v1.0.0.0**
- Initial release — NBA, WNBA, and G League scores from ESPN; live/pre-game/final/next-game states; crunch-time clock and 15-second refresh; lead-change flash; end-of-game fireworks; Gamecast or Custom Link on key press; custom key background; search with NBA → G League affiliates
