This repository contains a vencord plugin to spoof your device to mobile in discord. This allows you to do mobile only quests. 
Note: for all quests possible on mobile, the progress is currently bugged. I don't feel like fixing that, but if you see this and know how to do this, or if you want to add/fix something else, please feel free to contribute. 
Note: this was mostly made with AI. I did review and edit the code to make it work exactly how I want.
Note: this plugin works by reloading your discord. Sometimes you might get stuck on the loading page. Try completely exiting discord and open it again. You can also adjust the time before the reconnect happens in the code, (edit the number (milliseconds) at the end of line 184 of /mobileSpoof/index.ts: setTimeout(() => checkAndForceReconnect(), 20000);) This has to be done cause discord sends the session details before the plugin can intercept them.

License: MIT. copyright: github username: pannenkoekissus. See the LICENSE file for more information. Since I want to submit this to vencord, the index.ts has it's own copyright notice, but that only goes in effect when this file is part of vencord.
