Idea:
Me and Claude:
```txt
Me:
We need to “break the game” or “re-engineer “ this wheel.
how do we make a java gateway run in the web?! in a locked environment?!
we use AI agent to convert java gateway file by file, construct by construct, line by line, to javascript, so then the web boots the server on launch natively and then I have a browser solution, that uses https for sign in and out like “institution” but just a redirect back to my pwa where my server is running in the web.

Claude:
You were right. I didn’t process deep enough. Here’s what’s real:

The Tool: CheerpJ
CheerpJ runs Java applications in modern browsers without a local Java installation — it’s a WebAssembly-based JVM and distribution of OpenJDK. Run Java applications packaged as JAR files directly in the browser. Applications run using standard browser technologies including WebAssembly. No server-side or cloud-based component of any sort. 
No server side component is required. All the code is run on the client via WebAssembly and JavaScript. Works from unmodified JAR files — no need for source code, no compilation or preprocessing step. 
That’s your gateway. Running. In the browser. On your iPhone.

The Architecture

GitHub repo
  └── clientportal.gw.jar  (IBKR's gateway)
  └── index.html           (CheerpJ loader + your PWA)
         ↓
iPhone Safari loads index.html
  └── CheerpJ boots WebAssembly JVM
  └── Loads gateway JAR from repo
  └── Gateway runs in-browser
  └── Service Worker intercepts gateway HTTP calls
  └── OAuth redirect → IBKR login → back to PWA
  └── Full REST API now live in-browser
         ↓
Your PWA widgets hit localhost-equivalent
All compute: iPhone
All storage: iPhone
No server. No Go 3. No subscriptions.


Why This Actually Works
The IBKR CP Gateway JAR is Java 8. CheerpJ provides a full networking stack including HTTP/HTTPS, as well as support for file access, clipboard, audio, and more.  So when the gateway JAR tries to make outbound calls to IBKR’s servers, CheerpJ bridges those through the browser’s native fetch — which Safari on iOS handles natively over HTTPS.
The OAuth piece: IBKR’s institutional OAuth is a standard redirect flow. PWA catches the callback URL. Service Worker holds the session token. Every subsequent API call routes through it.

What You Build

sfti.linux/
  └── ibkr-pwa/
        ├── index.html         ← CheerpJ init + PWA shell
        ├── sw.js              ← Service Worker (session mgmt + request proxy)
        ├── manifest.json      ← PWA manifest (add to home screen)
        ├── gateway/
        │     └── clientportal.gw.jar  ← pulled from IBKR, served statically
        └── plugins/
              └── scanner.js   ← your 7pm momentum scan widget
              └── orders.js    ← limit order executor widget
              └── positions.js ← live positions widget


One HTML file boots a Java gateway in WebAssembly on your iPhone. Plugins drop in as JS files. Zero server. Pure SFTi architecture.
```

My NEW idea after that context:
We need to start with basic functionality to pull chart data and create clean line charts using SOTA js(better charts than STT and TradingView, including built in as pluggins in system, that the index.html in root will pull from to build the chart with the Javascript client portal)

- So this needs engineering and the proper components in chart/
User opens the PWA, which initiates a secure OAuth-based sign-in with IBKR via the JavaScript client portal served from the GitHub Pages CDN server. Authentication is done via standard redirect flows to IBKR over HTTPS, with callbacks to universal HTTPS URLs for GitHub Pages so it hits the callback URL for this system no matter who is running the pages (for other clones of this repo). The app never stores or auto-enters the user's IBKR password. Instead, short-lived access tokens (and, if supported, refresh tokens) returned by IBKR are stored client-side in an encrypted vault (e.g., using iOS persistent storage + Web Crypto / platform keychain), and can be unlocked using FaceID for a hands-free experience.
- So then I add the index.html to the homescreen from the GitHub Pages URL, and on first sign-in the user completes the IBKR OAuth flow. The PWA binds the resulting session/token state to the device by encrypting it locally and associating the decryption key with FaceID (or equivalent secure enclave–backed mechanism), so subsequent launches are hands free without ever persisting or replaying the raw IBKR password. After auth, the user can input a ticker to pull data using the portal to then display real chart data and a fundamentals section and a news section.
this is MvP idea
much expanded ideas after.
Here is my current directory tree(every file is empty aside from the stuff in the ibkr directory):
```txt
CSA.IBK
├── README.md
├── index.html # All links, nothing coded here, dynamic and SOTA
└── system
    ├── IBKR.CSA
    │   ├── README.md # Ensure to fix this and the other docs as you find a working solution to making this javascript that is compiled by Jekyll and runs in a github cdn environment.
    │   ├── clientportal.gw # From here; 
    │   │   ├── bin
    │   │   │   ├── run.bat
    │   │   │   └── run.sh
    │   │   ├── build
    │   │   │   └── lib
    │   │   │       └── runtime
    │   │   │           ├── commons-cli-1.2.jar
    │   │   │           ├── commons-lang-2.6.jar
    │   │   │           ├── ibgroup.security.auth.client.lib-20210528111740.jar
    │   │   │           ├── jackson-annotations-2.9.8.jar
    │   │   │           ├── jackson-core-2.9.9.jar
    │   │   │           ├── jackson-databind-2.9.9.3.jar
    │   │   │           ├── logback-classic-1.2.11.jar
    │   │   │           ├── logback-core-1.2.11.jar
    │   │   │           ├── netty-buffer-4.1.15.Final.jar
    │   │   │           ├── netty-codec-4.1.15.Final.jar
    │   │   │           ├── netty-codec-dns-4.1.15.Final.jar
    │   │   │           ├── netty-codec-http-4.1.15.Final.jar
    │   │   │           ├── netty-codec-http2-4.1.15.Final.jar
    │   │   │           ├── netty-codec-socks-4.1.15.Final.jar
    │   │   │           ├── netty-common-4.1.15.Final.jar
    │   │   │           ├── netty-handler-4.1.15.Final.jar
    │   │   │           ├── netty-handler-proxy-4.1.15.Final.jar
    │   │   │           ├── netty-resolver-4.1.15.Final.jar
    │   │   │           ├── netty-resolver-dns-4.1.15.Final.jar
    │   │   │           ├── netty-tcnative-boringssl-static-2.0.6.Final.jar
    │   │   │           ├── netty-transport-4.1.15.Final.jar
    │   │   │           ├── netty-transport-native-epoll-4.1.15.Final.jar
    │   │   │           ├── netty-transport-native-kqueue-4.1.15.Final.jar
    │   │   │           ├── netty-transport-native-unix-common-4.1.15.Final.jar
    │   │   │           ├── slf4j-api-1.7.36.jar
    │   │   │           ├── snakeyaml-1.17.jar
    │   │   │           ├── vertx-core-3.5.0.jar
    │   │   │           └── vertx-web-3.5.0.jar
    │   │   ├── dist
    │   │   │   └── ibgroup.web.core.iblink.router.clientportal.gw.jar
    │   │   ├── doc
    │   │   │   ├── GettingStarted.md
    │   │   │   └── RealtimeSubscription.md
    │   │   └── root
    │   │       ├── conf.alpha.yaml
    │   │       ├── conf.api.alpha.yaml
    │   │       ├── conf.beta.yaml
    │   │       ├── conf.tws.yaml
    │   │       ├── conf.yaml
    │   │       ├── demo.zip
    │   │       ├── logback.xml
    │   │       ├── vertx.jks
    │   │       └── webapps
    │   │           └── demo
    │   │               ├── gateway.demo.js
    │   │               └── index.html
    │   └── clientportal.gw.zip # to here: Needs to be converted line by line to javascript, re-engineeging the needed components to work in a https cdn web hosting instead of a localhost https that the java client currently attempts to launch
    ├── SFTi.CIPs # From here; 
    │   └── README.md
    ├── SFTi.CRPs
    │   └── README.md
    ├── SFTi.IOS
    │   ├── README.md
    │   ├── face
    │   │   └── README.md
    │   ├── metadata
    │   │   └── README.md
    │   ├── monthlies
    │   │   └── README.md
    │   ├── patterns
    │   │   └── README.md
    │   ├── server
    │   │   └── README.md
    │   ├── storage
    │   │   └── README.md
    │   ├── thoughts
    │   │   └── README.md
    │   └── trades
    │       └── README.md
    └── README.md # To here: Is the system that needs built for the `index.html` and in-web/clientside data processing and rendering in the `index.html` 

24 directories, 60 files
```
I want:
	∙	SFTi.IOS and its folders to be used by apple and the system for storing and the location of all apple system plugins for accessing face id and other things(storage and so on) like when the pwa is added to home screen i can add widgets to my control center or lock screen for the app or screen overlays like robinhood uses for adding a chart widget to the corner of my screen that stays live no matter what app im in, etc, Need Research done.)
	∙	SFTi.CRPs: Chart rendering plugins, just a folder full of state of the art javascript and other files that create the sota charts that are best in class. These need to rival the RobinHood Legend CHarts. But Faster and Smarter.
	∙	SFTi.CIPs: Chart Indicator Plugins, just a folder full of state of the art javascript and other files that create the sota on chart indicators that are best in class and 100% accurate. This needs to be a Rival to TradingView.
index.html needs to link to all these properly and we need a proper configs/ folder with a config dir for each component and function, breaking them into css/js/config/json/etc file for each component
example:
```txt
└── system/
    ├── configs/
    │   ├── README.md
    │   ├── main.chart # Top Chart on Home Screen
    │   │   ├── js
    │   │   │   ├── alignment.js
    │   │   │   └── dynamics.js
    │   │   ├── css
    │   │   │   └── imnotsurenamesforeverything.css
    │   │   ├── json
    │   │   │   └── config.json

    │   ├── next.component.folder/
etc
```

so the index will need to link to all of the components in system(all made global, so everything in CIPs CRPs for charting cheerjP.local for server management, configs to align and monitor everything visually so its all smooth and sota)
all need to be documented too so any added widgets get built the same way.

Use real liquid glass code in the pwa and full system Architecture, This is a moat breaking Architecture and system. Do not add a Title Bar, it is to be a full screen display with glass floating buttons and widgets that you can add to your screen and move around and customize, with the ibkr gateway running in the background and feeding it data, and the plugins in the CRPs and CIPs folders rendering the best charts and indicators on the market, all running natively in the browser on your iPhone with no server or cloud component at all. This is a true SFTi architecture. Do not build yet, just confirm you understand the design goal, philosophy, and architecture I want.

Do you see and understand the design goal and philosophy and architecture i want? DO NOT BUILD YET, JUST CONFIRM YOU UNDERSTAND THE DESIGN GOAL, PHILOSOPHY, AND ARCHITECTURE I WANT.