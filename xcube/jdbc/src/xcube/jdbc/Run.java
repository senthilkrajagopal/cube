package xcube.jdbc;

import java.math.BigDecimal;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Types;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.OffsetDateTime;
import java.time.OffsetTime;

/**
 * One statement on a connection: executed with its binds, its rows read a
 * batch at a time as JSON, each cell in the form xcube answers it (the SQL
 * runner's `cellOf`, wechart's engine loader), and cancelled from any thread
 * without waiting.
 *
 * Every date and time is read as the wall time the database holds, through
 * java.time where the driver has it: the JVM runs in UTC, so a driver that
 * converts through java.util's zone moves nothing either.
 */
public final class Run {
  private static final long SAFE_INTEGER = 9007199254740991L;

  private final Connection connection;

  private volatile PreparedStatement statement;

  private volatile boolean cancelled;

  private ResultSet rows;

  private int[] kinds;

  private int[] scales;

  private boolean done;

  public Run(Connection connection) {
    this.connection = connection;
  }

  /** The cell kinds, from the JDBC type. */
  private static final int TEXT = 0;
  private static final int INTEGER = 1;
  private static final int BIGINT = 2;
  private static final int DECIMAL = 3;
  private static final int DOUBLE = 4;
  private static final int REAL = 5;
  private static final int BOOLEAN = 6;
  private static final int DATE = 7;
  private static final int TIMESTAMP = 8;
  private static final int TIMESTAMP_ZONED = 9;
  private static final int TIME = 10;
  private static final int TIME_ZONED = 11;
  private static final int BYTES = 12;

  /** A timestamp with a zone that a driver reports as TIMESTAMP (PostgreSQL's `timestamptz`), told by its name. */
  private static boolean zonedByName(String name) {
    String n = name == null ? "" : name.toLowerCase();
    return n.endsWith("tz") || n.contains("with time zone") || n.contains("with timezone");
  }

  private static int kindOf(int type, String name) {
    if ((type == Types.TIMESTAMP || type == Types.TIME) && zonedByName(name)) {
      return type == Types.TIMESTAMP ? TIMESTAMP_ZONED : TIME_ZONED;
    }
    switch (type) {
      case Types.TINYINT:
      case Types.SMALLINT:
      case Types.INTEGER:
        return INTEGER;
      case Types.BIGINT:
        return BIGINT;
      case Types.DECIMAL:
      case Types.NUMERIC:
        return DECIMAL;
      case Types.DOUBLE:
      case Types.FLOAT:
        return DOUBLE;
      case Types.REAL:
        return REAL;
      case Types.BOOLEAN:
      case Types.BIT:
        return BOOLEAN;
      case Types.DATE:
        return DATE;
      case Types.TIMESTAMP:
        return TIMESTAMP;
      case Types.TIMESTAMP_WITH_TIMEZONE:
        return TIMESTAMP_ZONED;
      case Types.TIME:
        return TIME;
      case Types.TIME_WITH_TIMEZONE:
        return TIME_ZONED;
      case Types.BINARY:
      case Types.VARBINARY:
      case Types.LONGVARBINARY:
      case Types.BLOB:
        return BYTES;
      default:
        return TEXT;
    }
  }

  /**
   * Prepares and executes the statement, its `?` bound in order: a boolean
   * as one, anything else as its text (xcube's placeholders cast it in the
   * SQL). Answers its columns as JSON: `[{"name", "type"}]`.
   */
  public String execute(String sql, String[] types, String[] values, int timeoutS, int fetchRows) throws SQLException {
    PreparedStatement s = connection.prepareStatement(sql, ResultSet.TYPE_FORWARD_ONLY, ResultSet.CONCUR_READ_ONLY);
    statement = s;
    if (cancelled) {
      close();
      throw new SQLException("The statement was cancelled before it ran", "57014");
    }
    if (timeoutS > 0) {
      s.setQueryTimeout(timeoutS);
    }
    if (fetchRows > 0) {
      s.setFetchSize(fetchRows);
    }
    for (int i = 0; i < types.length; i++) {
      if ("boolean".equals(types[i])) {
        s.setBoolean(i + 1, Boolean.parseBoolean(values[i]));
      } else {
        s.setString(i + 1, values[i]);
      }
    }
    rows = s.executeQuery();
    ResultSetMetaData meta = rows.getMetaData();
    int n = meta.getColumnCount();
    kinds = new int[n];
    scales = new int[n];
    StringBuilder out = new StringBuilder("[");
    for (int i = 0; i < n; i++) {
      int type = meta.getColumnType(i + 1);
      String name = meta.getColumnTypeName(i + 1);
      kinds[i] = kindOf(type, name);
      scales[i] = safeScale(meta, i + 1);
      if (kinds[i] == DECIMAL && meta.getPrecision(i + 1) > 0) {
        name = name + "(" + meta.getPrecision(i + 1) + "," + Math.max(0, meta.getScale(i + 1)) + ")";
      }
      if (i > 0) {
        out.append(',');
      }
      out.append("{\"name\":");
      Json.string(out, meta.getColumnLabel(i + 1));
      out.append(",\"type\":");
      Json.string(out, name);
      out.append('}');
    }
    return out.append(']').toString();
  }

  private static int safeScale(ResultSetMetaData meta, int i) {
    try {
      return meta.getScale(i);
    } catch (SQLException e) {
      return -1;
    }
  }

  /** Whether the last fetch read the last row. */
  public boolean done() {
    return done;
  }

  /**
   * The next rows, at most `maxRows` and about `maxChars` of JSON (the row
   * that passes it is the last): `[[cell, …], …]`, empty once done.
   */
  public String fetch(int maxRows, int maxChars) throws SQLException {
    StringBuilder out = new StringBuilder("[");
    int count = 0;
    while (!done && count < maxRows && out.length() < maxChars) {
      if (!rows.next()) {
        done = true;
        break;
      }
      if (count > 0) {
        out.append(',');
      }
      out.append('[');
      for (int i = 0; i < kinds.length; i++) {
        if (i > 0) {
          out.append(',');
        }
        cell(out, i + 1);
      }
      out.append(']');
      count++;
    }
    return out.append(']').toString();
  }

  private void cell(StringBuilder out, int i) throws SQLException {
    int kind = kinds[i - 1];
    switch (kind) {
      case INTEGER: {
        int v = rows.getInt(i);
        out.append(rows.wasNull() ? "null" : Integer.toString(v));
        return;
      }
      case BIGINT: {
        long v = rows.getLong(i);
        if (rows.wasNull()) {
          out.append("null");
        } else if (Math.abs(v) > SAFE_INTEGER || v == Long.MIN_VALUE) {
          out.append('"').append(v).append('"');
        } else {
          out.append(v);
        }
        return;
      }
      case DECIMAL: {
        BigDecimal v = rows.getBigDecimal(i);
        if (v == null) {
          out.append("null");
        } else {
          out.append('"').append(v.toPlainString()).append('"');
        }
        return;
      }
      case DOUBLE: {
        double v = rows.getDouble(i);
        if (rows.wasNull()) {
          out.append("null");
        } else if (Double.isNaN(v) || Double.isInfinite(v)) {
          Json.string(out, rows.getString(i));
        } else {
          out.append(Double.toString(v));
        }
        return;
      }
      case REAL: {
        float v = rows.getFloat(i);
        if (rows.wasNull()) {
          out.append("null");
        } else if (Float.isNaN(v) || Float.isInfinite(v)) {
          Json.string(out, rows.getString(i));
        } else {
          out.append(Float.toString(v));
        }
        return;
      }
      case BOOLEAN: {
        boolean v = rows.getBoolean(i);
        out.append(rows.wasNull() ? "null" : Boolean.toString(v));
        return;
      }
      case DATE: {
        LocalDate v = date(i);
        if (v == null) {
          out.append("null");
        } else {
          Json.string(out, v.toString());
        }
        return;
      }
      case TIMESTAMP: {
        LocalDateTime v = timestamp(i);
        if (v == null) {
          out.append("null");
        } else {
          Json.string(out, v.toLocalDate().toString() + " " + time(v.toLocalTime(), scales[i - 1]));
        }
        return;
      }
      case TIMESTAMP_ZONED: {
        OffsetDateTime v = rows.getObject(i, OffsetDateTime.class);
        if (v == null) {
          out.append("null");
        } else {
          Json.string(out, v.toLocalDate().toString() + " " + time(v.toLocalTime(), scales[i - 1]) + offset(v.getOffset().getTotalSeconds()));
        }
        return;
      }
      case TIME: {
        LocalTime v = localTime(i);
        if (v == null) {
          out.append("null");
        } else {
          Json.string(out, time(v, scales[i - 1]));
        }
        return;
      }
      case TIME_ZONED: {
        OffsetTime v = rows.getObject(i, OffsetTime.class);
        if (v == null) {
          out.append("null");
        } else {
          Json.string(out, time(v.toLocalTime(), scales[i - 1]) + offset(v.getOffset().getTotalSeconds()));
        }
        return;
      }
      case BYTES: {
        byte[] v = rows.getBytes(i);
        if (v == null) {
          out.append("null");
        } else {
          Json.bytes(out, v);
        }
        return;
      }
      default:
        Json.string(out, rows.getString(i));
    }
  }

  private LocalDate date(int i) throws SQLException {
    try {
      return rows.getObject(i, LocalDate.class);
    } catch (SQLException | RuntimeException e) {
      java.sql.Date d = rows.getDate(i);
      return d == null ? null : d.toLocalDate();
    }
  }

  private LocalDateTime timestamp(int i) throws SQLException {
    try {
      return rows.getObject(i, LocalDateTime.class);
    } catch (SQLException | RuntimeException e) {
      java.sql.Timestamp t = rows.getTimestamp(i);
      return t == null ? null : t.toLocalDateTime();
    }
  }

  private LocalTime localTime(int i) throws SQLException {
    try {
      return rows.getObject(i, LocalTime.class);
    } catch (SQLException | RuntimeException e) {
      java.sql.Time t = rows.getTime(i);
      return t == null ? null : t.toLocalTime();
    }
  }

  /** `HH:MM:SS`, and the fraction to the column's scale where it has one, else as far as it isn't zero. */
  static String time(LocalTime t, int scale) {
    StringBuilder out = new StringBuilder();
    pad(out, t.getHour());
    out.append(':');
    pad(out, t.getMinute());
    out.append(':');
    pad(out, t.getSecond());
    String nanos = String.format("%09d", t.getNano());
    if (scale > 0 && scale <= 9) {
      out.append('.').append(nanos, 0, scale);
    } else if (scale < 0 || scale > 9) {
      String trimmed = nanos.replaceAll("0+$", "");
      if (!trimmed.isEmpty()) {
        out.append('.').append(trimmed);
      }
    }
    return out.toString();
  }

  /** `±HH:MM`. */
  static String offset(int seconds) {
    StringBuilder out = new StringBuilder(seconds < 0 ? "-" : "+");
    int s = Math.abs(seconds);
    pad(out, s / 3600);
    out.append(':');
    pad(out, (s / 60) % 60);
    return out.toString();
  }

  private static void pad(StringBuilder out, int n) {
    if (n < 10) {
      out.append('0');
    }
    out.append(n);
  }

  /**
   * Cancels the statement on the database from a thread of its own, at once:
   * the caller never waits on the network, nor behind statements running.
   */
  public void cancel() {
    cancelled = true;
    final PreparedStatement s = statement;
    if (s != null) {
      Thread t = new Thread(() -> {
        try {
          s.cancel();
        } catch (Throwable ignored) {
          // Best effort: the run's connection is closed after.
        }
      }, "xcube-jdbc-cancel");
      t.setDaemon(true);
      t.start();
    }
  }

  /**
   * Closes its rows and statement from a thread of its own, at once: a close
   * can wait on the network, and the caller never waits behind statements
   * running.
   */
  public void closeLater() {
    Thread t = new Thread(this::close, "xcube-jdbc-close");
    t.setDaemon(true);
    t.start();
  }

  /** Closes its rows and statement; never throws. */
  public void close() {
    try {
      if (rows != null) {
        rows.close();
      }
    } catch (Throwable ignored) {
      // Closing anyway.
    }
    try {
      PreparedStatement s = statement;
      if (s != null) {
        s.close();
      }
    } catch (Throwable ignored) {
      // Closing anyway.
    }
  }
}
