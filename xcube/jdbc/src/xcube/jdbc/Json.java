package xcube.jdbc;

/** JSON text, written by hand: the helper has no dependency. */
final class Json {
  private Json() {}

  private static final char[] HEX = "0123456789abcdef".toCharArray();

  /** A string, or null; a surrogate is escaped, so an unpaired one stays valid JSON. */
  static void string(StringBuilder out, String s) {
    if (s == null) {
      out.append("null");
      return;
    }
    out.append('"');
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      switch (c) {
        case '"':
          out.append("\\\"");
          break;
        case '\\':
          out.append("\\\\");
          break;
        case '\n':
          out.append("\\n");
          break;
        case '\r':
          out.append("\\r");
          break;
        case '\t':
          out.append("\\t");
          break;
        default:
          if (c < 0x20 || Character.isSurrogate(c) || c == 0x2028 || c == 0x2029) {
            out.append("\\u").append(HEX[(c >> 12) & 15]).append(HEX[(c >> 8) & 15]).append(HEX[(c >> 4) & 15]).append(HEX[c & 15]);
          } else {
            out.append(c);
          }
      }
    }
    out.append('"');
  }

  /** Bytes as PostgreSQL's hex form, `\x` and two digits each, in a JSON string. */
  static void bytes(StringBuilder out, byte[] b) {
    out.append("\"\\\\x");
    for (byte x : b) {
      out.append(HEX[(x >> 4) & 15]).append(HEX[x & 15]);
    }
    out.append('"');
  }
}
