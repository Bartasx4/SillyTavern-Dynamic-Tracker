# Dynamic Tracker

Dynamic Tracker is a SillyTavern third-party extension that creates structured tracker summaries for chat messages by using a user-defined field tree.

## Main features

- Auto Mode for user messages, model responses, or both
- Multiple schema presets (create / rename / delete)
- Dynamic field tree with nested groups, objects, and arrays
- JSON schema preview popup
- Manual tracker generation button on each message
- Tracker injection into normal prompt generation through a prompt interceptor
- Per-swipe tracker storage (each swipe can have its own tracker)

## Install

Copy the whole folder into:

`SillyTavern/data/<your-user>/extensions/SillyTavern-Dynamic-Tracker`

Then reload SillyTavern.

## Notes

- The tracker wrapper HTML is stored in `tracker.html`.
- The generated JSON schema is built at runtime from the configured field tree.
- Existing trackers keep a snapshot of the field tree used when they were generated, so later preset edits do not break old messages.
