import Foundation

/// The page → native half of `native/ios/BRIDGE.md`, free of WebKit so it can be unit tested.
/// Voice and dictation are stubs until plan Steps 5 and 8.
@MainActor
struct NativeBridge {
    let model: AppModel
    let primaryOrigin: String
    var dictation: Dictation = .shared

    enum Reply: Equatable {
        case value(JSON)
        case error(String)
    }

    func handle(_ body: JSON) async -> Reply {
        switch body["type"]?.string {
        case "prefs":
            guard let key = body["key"]?.string else { return .error("missing key") }
            model.prefs.set(key, body["value"]?.string)
            return .value(.null)
        case "machines":
            let list = (body["machines"]?.array ?? []).compactMap { Machine(web: $0, primaryOrigin: primaryOrigin) }
            await model.webMachines(list)
            return .value(.null)
        case "unpaired":
            await model.webUnpaired()
            return .value(.null)
        case "voice.start":
            return .error("Voice mode isn't in this version of the app yet.")
        case "dictation.start":
            do { try await dictation.start(); return .value(.null) } catch { return .error(error.localizedDescription) }
        case "dictation.stop":
            do {
                let audio = try await dictation.stop()
                return .value(["audio": .string(audio.base64EncodedString()), "mime": "audio/mp4"])
            } catch { return .error(error.localizedDescription) }
        case "dictation.cancel":
            dictation.cancel()
            return .value(.null)
        default:
            return .error("unknown message")
        }
    }

    /// The document-start script: the Keychain's machines, the primary device and voice prefs, then `PiNative`.
    static func setupScript(machines: [Machine], prefs: [String: String]) -> String {
        let entries = JSON.array(machines.map(\.webEntry))
        let device: JSON = machines.first(where: \.primary)?.webDevice ?? .null
        func js(_ v: JSON) -> String { String(decoding: (try? v.data()) ?? Data("null".utf8), as: UTF8.self) }
        let p = JSON.object(prefs.mapValues { .string($0) })
        return """
        (function () {
          try {
            var s = window.localStorage;
            s.setItem("pi-mobile-machines", JSON.stringify(\(js(entries))));
            var dev = \(js(device));
            if (dev) s.setItem("pi-mobile-device", JSON.stringify(dev)); else s.removeItem("pi-mobile-device");
            var prefs = \(js(p));
            for (var k in prefs) s.setItem(k, prefs[k]);
          } catch (e) {}
          window.PiNative = window.PiNative || {};
          window.PiNative.version = 1;
        })();
        """
    }

    /// Native feel: no pinch zoom, no long-press callouts on links and images, no tap flash.
    static let feelScript = """
    (function () {
      var m = document.querySelector('meta[name=viewport]');
      if (m && !/maximum-scale/.test(m.content)) m.content += ', maximum-scale=1, user-scalable=no';
      var st = document.createElement('style');
      st.textContent = 'a, img { -webkit-touch-callout: none; } * { -webkit-tap-highlight-color: transparent; }';
      document.head.appendChild(st);
    })();
    """
}
