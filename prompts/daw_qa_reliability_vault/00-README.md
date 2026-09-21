# DAW QA & Reliability Vault

A reusable audit suite for browser-based or hybrid DAWs.

## Recommended Order

1. Editing & Timeline
2. Transport
3. Audio Scheduling
4. Mixer
5. Plugins & Effects
6. Automation
7. Recording
8. Project State
9. Undo / Redo
10. Import
11. Export / Bounce
12. Audio Engine
13. Async & Race Conditions
14. Browser Lifecycle
15. Performance
16. UI Responsiveness
17. Keyboard & Shortcuts
18. Error Handling
19. Recovery
20. Memory & Resources
21. Data Integrity
22. Cross-Component Contracts
23. Browser Compatibility
24. Security Surface
25. Real-User Chaos Test

## Operating Principle

Run audits one at a time.

For every confirmed issue:
**reproduce → regression test → smallest correct fix → verify → sibling-pattern sweep**

Do not manufacture changes when an area is already healthy.

The final chaos test should be run only after the narrower subsystem audits have completed.
