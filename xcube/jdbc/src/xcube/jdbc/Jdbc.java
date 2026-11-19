package xcube.jdbc;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.Driver;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.SQLTimeoutException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Properties;

import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;

/**
 * xcube's JDBC helper: what node-java calls, so that a connection is made
 * from xcube's own settings alone and a row set is read a batch at a time,
 * never a cell per call across the bridge.
 */
public final class Jdbc {
  private Jdbc() {}

  /** The JVM's version, for the image's check. */
  public static String javaVersion() {
    return System.getProperty("java.version");
  }

  /**
   * Closes a connection from a thread of its own, at once: closing can wait
   * on the network, and the caller never waits behind statements running.
   */
  public static void closeLater(final Connection connection) {
    Thread t = new Thread(() -> {
      try {
        connection.close();
      } catch (Throwable ignored) {
        // Closed as far as it can be.
      }
    }, "xcube-jdbc-close");
    t.setDaemon(true);
    t.start();
  }

  /**
   * The catalog as the driver's DatabaseMetaData reads it, for a database
   * whose own views xcube doesn't read (TDV): `schemas` [catalog, schema];
   * `tables` [catalog, schema, table, type]; `columns` [catalog, schema,
   * table, column, type], in order. A null or empty argument is any.
   */
  public static String catalog(Connection connection, String what, String catalog, String schema, String table) throws SQLException {
    DatabaseMetaData meta = connection.getMetaData();
    String cat = catalog == null || catalog.isEmpty() ? null : catalog;
    String sch = schema == null || schema.isEmpty() ? null : schema;
    String tab = table == null || table.isEmpty() ? "%" : table;
    StringBuilder out = new StringBuilder("[");
    String[] columns;
    ResultSet rows;
    switch (what) {
      case "schemas":
        rows = meta.getSchemas();
        columns = new String[] {"TABLE_CATALOG", "TABLE_SCHEM"};
        break;
      case "tables":
        rows = meta.getTables(cat, sch, tab, new String[] {"TABLE", "VIEW"});
        columns = new String[] {"TABLE_CAT", "TABLE_SCHEM", "TABLE_NAME", "TABLE_TYPE"};
        break;
      case "columns":
        rows = meta.getColumns(cat, sch, tab, "%");
        columns = new String[] {"TABLE_CAT", "TABLE_SCHEM", "TABLE_NAME", "COLUMN_NAME", "TYPE_NAME"};
        break;
      default:
        throw new IllegalArgumentException("No catalog read " + what);
    }
    try {
      boolean first = true;
      while (rows.next()) {
        out.append(first ? "[" : ",[");
        first = false;
        for (int i = 0; i < columns.length; i++) {
          if (i > 0) {
            out.append(',');
          }
          String value;
          try {
            value = rows.getString(columns[i]);
          } catch (SQLException e) {
            // A driver without the column (an older one's TABLE_CATALOG).
            value = null;
          }
          Json.string(out, value);
        }
        out.append(']');
      }
    } finally {
      rows.close();
    }
    return out.append(']').toString();
  }

  /** Whether the classpath holds a class: a vendor jar provides its driver. */
  public static boolean provides(String className) {
    try {
      Class.forName(className, false, Jdbc.class.getClassLoader());
      return true;
    } catch (Throwable e) {
      return false;
    }
  }

  /**
   * A connection made by the driver class itself, never through
   * DriverManager: no other driver on the classpath is asked, and no system
   * property or file names the URL.
   */
  public static Connection connect(String driverClass, String url, String[] keys, String[] values, boolean readOnly) throws Exception {
    Driver driver = (Driver) Class.forName(driverClass, true, Jdbc.class.getClassLoader()).getDeclaredConstructor().newInstance();
    Properties properties = new Properties();
    for (int i = 0; i < keys.length; i++) {
      properties.setProperty(keys[i], values[i]);
    }
    Connection connection = driver.connect(url, properties);
    if (connection == null) {
      throw new SQLException(driverClass + " doesn't take the URL xcube made for it");
    }
    try {
      if (readOnly) {
        connection.setReadOnly(true);
      }
      connection.setAutoCommit(true);
    } catch (SQLException e) {
      connection.close();
      throw e;
    }
    return connection;
  }

  /**
   * Trusts the PEM bundle's certificates beside the JRE's own, for every
   * connection that takes the JVM's default (TDV's driver reads only that):
   * an in-memory key store, installed as the default SSLContext before any
   * connection opens. Nothing is written to disk.
   */
  public static int trust(String pem) throws Exception {
    CertificateFactory factory = CertificateFactory.getInstance("X.509");
    Collection<? extends Certificate> extra = factory.generateCertificates(new ByteArrayInputStream(pem.getBytes(StandardCharsets.US_ASCII)));
    if (extra.isEmpty()) {
      throw new IllegalArgumentException("The trust store holds no certificate");
    }
    TrustManagerFactory defaults = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
    defaults.init((KeyStore) null);
    KeyStore store = KeyStore.getInstance(KeyStore.getDefaultType());
    store.load(null, null);
    int n = 0;
    for (TrustManager tm : defaults.getTrustManagers()) {
      if (tm instanceof X509TrustManager) {
        for (X509Certificate cert : ((X509TrustManager) tm).getAcceptedIssuers()) {
          store.setCertificateEntry("jre-" + (n++), cert);
        }
      }
    }
    int added = 0;
    for (Certificate cert : extra) {
      store.setCertificateEntry("xcube-" + (added++), cert);
    }
    TrustManagerFactory both = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
    both.init(store);
    SSLContext context = SSLContext.getInstance("TLS");
    context.init(null, both.getTrustManagers(), null);
    SSLContext.setDefault(context);
    return added;
  }

  /** An exception's chain, as Node reads it: each cause's class, SQLSTATE, vendor code and message. */
  public static String describe(Throwable e) {
    StringBuilder out = new StringBuilder("[");
    List<Throwable> seen = new ArrayList<>();
    for (Throwable t = e; t != null && !seen.contains(t) && seen.size() < 8; t = t.getCause()) {
      seen.add(t);
      if (out.length() > 1) {
        out.append(',');
      }
      out.append("{\"class\":");
      Json.string(out, t.getClass().getName());
      if (t instanceof SQLException) {
        SQLException s = (SQLException) t;
        out.append(",\"sqlState\":");
        Json.string(out, s.getSQLState());
        out.append(",\"code\":").append(s.getErrorCode());
        out.append(",\"timeout\":").append(t instanceof SQLTimeoutException);
      }
      out.append(",\"message\":");
      Json.string(out, t.getMessage());
      out.append('}');
    }
    return out.append(']').toString();
  }
}
