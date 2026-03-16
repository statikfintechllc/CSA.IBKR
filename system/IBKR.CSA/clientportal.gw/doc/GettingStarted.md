# Getting Started

## Browser-Native Mode (CheerpJ — No Local Install Required)

The CSA.IBKR PWA can run the IBKR Client Portal Gateway **entirely in the browser** using CheerpJ 3.0 (a Java-to-WebAssembly JVM by Leaning Technologies).

**How it works:**

1. CheerpJ 3.0 boots a WebAssembly JVM inside the browser
2. The gateway JARs are loaded via `cheerpjRunLibrary()` (library mode — no TCP server socket needed)
3. A purpose-built Java class (`BrowserGateway.java`) uses `java.net.HttpURLConnection` which CheerpJ transparently maps to the browser's `fetch()` API
4. All IBKR API calls go through this Java bridge → directly to `api.ibkr.com`
5. No localhost server, no manual install, no Java on the machine

**To authenticate:**

1. Open the PWA in a modern browser (Chrome, Edge, Firefox)
2. Wait for "Gateway ready" (CheerpJ loads the JVM — takes a few seconds on first load)
3. Click "Sign In" → IBKR SSO opens in a popup
4. Log in with your IBKR credentials + 2FA
5. The popup closes and you're authenticated

**Source files:**
- `src/ibgroup/web/core/clientportal/gw/browser/BrowserGateway.java` — the browser-native proxy class
- `build/lib/runtime/browser-gateway.jar` — compiled JAR loaded by CheerpJ
- `../../cheerpJ.local/cheerpj.js` — CheerpJ integration (library mode)
- `../../SFTi.IOS/server/gateway.js` — gateway lifecycle manager

---

## Traditional Mode (Local Java Gateway)

The Client Portal gateway is available for download at: [http://download2.interactivebrokers.com/portal/clientportal.gw.zip](http://download2.interactivebrokers.com/portal/clientportal.gw.zip)

You can download and extract to any location your user has access to. We will install it under 

C:\gateway\ in Windows or ~user\gateway in Linux.

The gateway requires Java 1.8 update 192 or higher to run, and has been tested successfully with OpenJDK 11. 

Oracle Java 8 download: [https://www.oracle.com/technetwork/java/javase/downloads/jre8-downloads-2133155.html](https://www.oracle.com/technetwork/java/javase/downloads/jre8-downloads-2133155.html)

Once you extract the .zip file, you will see the following directories:

- **bin** contains the run scripts for Linux and Windows

- **build** contains all the 3rd party libraries required for the gateway to run

- **dist** contains the .jar file for the gateway

- **doc** contains this GettingStarted.md guide

- **root** contains files required for the runtime configuration of the gateway and is also the location where webapps reside. We will explain those in more detail later.

- **src** contains the BrowserGateway.java source for the browser-native bridge

To start the gateway you need to open a command prompt or bash on the directory the files were extracted. In our case we will open windows -> run -> cmd and go to c:\gateway\.

Once in that directory you can run *"bin\run.sh root/conf.yaml"* or *"bin\run.bat root\conf.yaml"*

Once the gateway is running, you should see the following entry in the console:
"Server listening on port 5000" 
By default the gateway runs in SSL mode and port 5000. 

Now that the gateway is running, you are ready to authenticate, to do that open your browser and go to:
[https://localhost:5000/](https://localhost:5000/)

In this page you should see our regular login page which is also visible here:
[https://gdcdyn.interactivebrokers.com/sso/Login?forwardTo=368](https://gdcdyn.interactivebrokers.com/sso/Login?forwardTo=368)

**Note:** The browser-native mode uses `forwardTo=368` which is the Client Portal API/Gateway authentication endpoint. This prevents IBKR from redirecting to IBKR Web after login, allowing the SSO popup to remain on the authentication confirmation page where session cookies are captured.

Once you login, the gateway will confirm the client is authenticated and is ok to close the browser window. Or will display any reasons why the authentication may have failed.

Once the gateway is authenticated you can close the browser or navigate away.

From this point on, the end points documented in the API spec should be available for you to query with curl or any other HTTP client.

[https://gdcdyn.interactivebrokers.com/portal.proxy/v1/portal/swagger/swagger?format=yaml](https://gdcdyn.interactivebrokers.com/portal.proxy/v1/portal/swagger/swagger?format=yaml)

[https://rebilly.github.io/ReDoc/?url=https://rebilly.github.io/ReDoc/?url=https://gdcdyn.interactivebrokers.com/portal.proxy/v1/portal/swagger/swagger?format=yaml](https://rebilly.github.io/ReDoc/?url=https://rebilly.github.io/ReDoc/?url=https://gdcdyn.interactivebrokers.com/portal.proxy/v1/portal/swagger/swagger?format=yaml)

There is an external Client Portal API guide with test pages at: [https://interactivebrokers.github.io/cpwebapi](https://interactivebrokers.github.io/cpwebapi)

