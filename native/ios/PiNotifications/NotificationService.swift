import UserNotifications

/// Opens the sealed text of a pi notification with the device key from the shared Keychain
/// (plans/native-apps.md §11). Without a key the generic "pi · New activity" stays.
final class NotificationService: UNNotificationServiceExtension {
    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        contentHandler(PushContent.rewrite(request.content, machines: MachineStore().load()))
    }

    override func serviceExtensionTimeWillExpire() {}
}
