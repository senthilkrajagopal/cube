-- xcube's database bootstrap: a login role `xcube` that owns a schema `xcube`,
-- and nothing else, in the database it runs in. xcube creates and migrates its
-- tables itself, as that role, on start.
--
-- Run it once per database, as a role that may create roles and schemas (the
-- cluster's admin), with psql, which substitutes the password:
--
--   psql -v ON_ERROR_STOP=1 -v xcube_password=… -d <database> -f bootstrap.sql
--
-- Running it again changes nothing but the password.

SELECT 'CREATE ROLE xcube LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION'
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'xcube') \gexec
ALTER ROLE xcube WITH LOGIN PASSWORD :'xcube_password' CONNECTION LIMIT 64;
SELECT format('GRANT CONNECT ON DATABASE %I TO xcube', current_database()) \gexec
CREATE SCHEMA IF NOT EXISTS xcube AUTHORIZATION xcube;
