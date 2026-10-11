import Network
import Observation

/// Counts network path changes so the offline screen can retry the moment Wi-Fi or the tailnet comes back.
@MainActor @Observable
final class NetworkWatch {
    private(set) var changes = 0
    private(set) var online = true
    @ObservationIgnored private let monitor = NWPathMonitor()

    init() {
        monitor.pathUpdateHandler = { [weak self] path in
            let ok = path.status == .satisfied
            Task { @MainActor in
                guard let self else { return }
                self.online = ok
                self.changes += 1
            }
        }
        monitor.start(queue: .global(qos: .utility))
    }

    deinit { monitor.cancel() }
}
