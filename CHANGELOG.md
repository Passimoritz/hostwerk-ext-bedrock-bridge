## 1.2.1

- No own sidebar entry any more (`nav: false`) – the move to “Minecraft server network” stays reachable via Extensions → Open and the hint on the Minecraft page. / Kein eigener Eintrag mehr in der Seitenleiste (`nav: false`) – der Umzug zu „Minecraft-Servernetzwerk“ bleibt über Erweiterungen → Öffnen und den Hinweis auf der Minecraft-Seite erreichbar.

## 1.2.0

- Replaced by the extension **Minecraft server network** (mc-network): Geyser belongs on the proxy in a network – once for every server –, plus Bedrock Dedicated Servers, version bridges and proxy networks. The page shows the move (“Move now”); the new extension takes over settings, ports and Floodgate keys without loss and moves Geyser from servers behind a proxy onto the proxy. As soon as it is installed, this extension steps aside (no own updates any more). / Abgelöst durch die Erweiterung **Minecraft-Servernetzwerk** (mc-network): In einem Netzwerk gehört Geyser auf den Proxy – einmal für alle Server –, dazu Bedrock Dedicated Server, Versions-Brücken und Proxy-Netzwerke. Die Seite bietet den Umzug an („Jetzt umziehen“); die neue Erweiterung übernimmt Einstellungen, Ports und Floodgate-Schlüssel ohne Verlust und zieht Geyser von Servern hinter einem Proxy auf den Proxy. Sobald sie installiert ist, tritt diese Erweiterung zur Seite (keine eigenen Updates mehr).

## 1.1.1

- The free Bedrock port skips UDP forwardings of the router through its public list (`router.forwards`, Router & port forwarding 1.2) instead of reading its settings; older router versions as before. / Freier Bedrock-Port beachtet Router-Freigaben über deren öffentliche Liste (`router.forwards`), ältere Router-Erweiterung wie bisher.

## 1.1.0

- Velocity with Floodgate: Floodgate and the proxy's key.pem on every backend, “send-floodgate-data” on – Bedrock players are no longer kicked (“Sync backends” after network changes). / Velocity mit Floodgate: Floodgate und key.pem des Proxys auf jedem Server im Netzwerk, „send-floodgate-data“ an – Bedrock-Spieler fliegen nicht mehr raus („Server im Netzwerk abgleichen“ nach Änderungen).
- Switching off cleans up: settings folders, waiting updates and Floodgate on backends; a running server offers “Restart now”. / Ausschalten räumt auf: Einstellungsordner, wartende Updates und Floodgate auf den Servern dahinter; ein laufender Server bietet „Jetzt neu starten“.
- No fixed two-minute wait at the first start: waits as long as the server keeps starting (up to 15 minutes) and rolls back on failure instead of staying half on. / Keine feste Wartezeit von zwei Minuten beim ersten Start: wartet, solange der Server startet (bis 15 Minuten), und nimmt bei Fehlern alles zurück statt halb an zu bleiben.
- Port search skips UDP ports of game servers and other public UDP ports and tests the port on this PC. / Die Port-Suche überspringt UDP-Ports von Spiele-Servern und anderen öffentlichen UDP-Ports und prüft den Port auf diesem PC.
- Addresses as sentences: at home (LAN address) and for friends outside (DynDNS, remote access domain or public IP), each with copy. / Adressen als Sätze: zu Hause (LAN-Adresse) und für Freunde draußen (DynDNS, Fernzugriffs-Domain oder öffentliche IP), jeweils zum Kopieren.
- Bedrock server list entry: two MOTD lines and server name, or the Java MOTD. / Serverlisten-Eintrag für Bedrock: zwei MOTD-Zeilen und Servername oder die Java-MOTD.
- Guide per platform (phone, Windows, Xbox, PlayStation, Switch – consoles via BedrockConnect). / Anleitung je Plattform (Handy, Windows, Xbox, PlayStation, Switch – Konsolen über BedrockConnect).
- GeyserOptionalPack with one switch, kept up to date with the update check. / GeyserOptionalPack per Schalter, wird mit der Update-Prüfung aktuell gehalten.
- Bedrock players online are marked on the page; service “bedrock” (isBedrock) and “prefix”/“bedrockPlayers” in the status for other extensions. / Bedrock-Spieler online werden auf der Seite gekennzeichnet; Dienst „bedrock“ (isBedrock) und „prefix“/„bedrockPlayers“ im Status für andere Erweiterungen.
- Error state with “Try again”, dates in Hostwerk's language, design scale, place in the sidebar after Minecraft, allowExtensions, synergies. / Fehlerzustand mit „Erneut versuchen“, Datum in Hostwerk-Sprache, Design-Skala, Platz in der Seitenleiste hinter Minecraft, allowExtensions, Synergien.
- Tests for switching on/off, update check, MOTD, Velocity backends and OptionalPack with a simulated download. Release package contains everything except the repository tooling. / Tests für An/Aus, Update-Prüfung, MOTD, Velocity-Server und OptionalPack mit nachgebildetem Download. Release-Paket enthält alles außer dem Repo-Werkzeug.

## 1.0.1

- Same symbol in the sidebar and in the page header (with Hostwerk 2.11 or newer). / Gleiches Symbol in der Seitenleiste und im Seitenkopf (ab Hostwerk 2.11).

## 1.0.0

- First release as its own extension (before: built into Hostwerk). Data stays where it was. / Erste Fassung als eigene Erweiterung (vorher fest in Hostwerk). Daten bleiben, wo sie waren.
