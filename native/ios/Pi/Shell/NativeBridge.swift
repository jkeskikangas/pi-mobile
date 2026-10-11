import Foundation

/// The page → native half of `native/ios/BRIDGE.md`, free of WebKit so it can be unit tested.
/// Prefs, machines, unpairing, focus, voice, dictation, push and scan are all handled here.
@MainActor
struct NativeBridge {
    let model: AppModel
    let primaryOrigin: String
    var dictation: Dictation = .shared
    var focusDefaults: UserDefaults = .standard
    var consent: AIConsent = .shared
    /// Presents the pairing-code scanner and waits for its outcome (`scan`).
    var scan: @MainActor () async -> ScanResult = { await ScanCenter.shared.scan() }

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
            do { try await model.webMachines(list) } catch { return .error(error.localizedDescription) }
            return .value(.null)
        case "unpaired":
            do { try await model.webUnpaired() } catch { return .error(error.localizedDescription) }
            return .value(.null)
        case "focus":
            // The session on screen in the web UI: "Start voice" (Siri, Control Center) picks it next.
            guard let agent = body["agent"]?.string, !agent.isEmpty else { return .value(.null) }
            let machine = body["machine"]?.string.flatMap { $0.isEmpty ? nil : $0 } ?? model.primary?.id ?? ""
            focusDefaults.set(["agent": agent, "machine": machine, "name": body["name"]?.string ?? ""], forKey: VoiceActivityController.lastKey)
            return .value(.null)
        case "voice.start":
            guard let agent = body["agent"]?.string, !agent.isEmpty else { return .error("Open a session first.") }
            let machine = body["machine"]?.string.flatMap { $0.isEmpty ? nil : $0 } ?? model.primary?.id ?? ""
            do {
                try await VoiceHost.start(model: model, agent: agent, machine: machine, dictation: dictation)
                return .value(.null)
            } catch { return .error(error.localizedDescription) }
        case "dictation.start":
            do { try await dictation.start(); return .value(.null) } catch { return .error(error.localizedDescription) }
        case "dictation.stop":
            do {
                let audio = try await dictation.stop()
                return .value(["audio": .string(audio.base64EncodedString()), "mime": "audio/mp4"])
            } catch { return .error(error.localizedDescription) }
        case "push.status":
            return .value(await PushCenter.shared.status())
        case "push.enable":
            do { return .value(try await PushCenter.shared.enable(body["on"]?.bool ?? true)) } catch { return .error(error.localizedDescription) }
        case "scan":
            switch await scan() {
            case .link(let link): return .value(["link": .string(link)])
            case .cancelled: return .error("cancelled")
            case .busy: return .error("busy")
            case .unavailable(let message): return .error(message)
            }
        case "consent.status":
            return .value(["granted": .bool(consent.granted)])
        case "consent.revoke":
            consent.revoke()
            return .value(["granted": false])
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
          window.PiNative.scan = true;
          window.PiNative.consent = true;
        })();
        """
    }

    /// Native feel: no long-press callouts on links and images, no tap flash. Pinch zoom stays (accessibility).
    static let feelScript = """
    (function () {
      var st = document.createElement('style');
      st.textContent = 'a, img { -webkit-touch-callout: none; } * { -webkit-tap-highlight-color: transparent; }';
      document.head.appendChild(st);
    })();
    """
}
