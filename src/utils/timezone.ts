/**
 * The time zone of the machine the server runs on, as an IANA name. One source for everything that shows a
 * local time: get_server_info reports it, and the course sync writes dates in it.
 */
export function localTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
