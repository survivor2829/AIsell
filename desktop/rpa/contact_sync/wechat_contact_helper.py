#!/usr/bin/env python3
import argparse
import json
import os
from pathlib import Path
import sqlite3
import sys


CONTACT_FIELDS = {
    "username": ["username", "UserName", "user_name", "wxid"],
    "alias": ["alias", "Alias", "wechat_id"],
    "remark": ["remark", "Remark", "con_remark"],
    "nick_name": ["nick_name", "NickName", "nickname", "nickName"],
    "local_type": ["local_type", "localType", "type", "Type", "contact_type", "contactType"],
    "verify_flag": ["verify_flag", "VerifyFlag", "verifyFlag", "verifyflag"],
    "chat_room_type": ["chat_room_type", "ChatRoomType", "chatRoomType", "chatroom_type"],
    "delete_flag": ["delete_flag", "DeleteFlag", "deleteFlag", "del_flag", "delFlag"],
    "deleted_at": ["deleted_at", "delete_time", "DeleteTime"],
}

INSPECT_VALUE_FIELDS = [
    "local_type",
    "localType",
    "type",
    "Type",
    "contact_type",
    "contactType",
    "verify_flag",
    "VerifyFlag",
    "verifyFlag",
    "chat_room_type",
    "ChatRoomType",
    "delete_flag",
    "DeleteFlag",
    "del_flag",
    "DelFlag",
    "flag",
    "Flag",
    "is_in_chat_room",
    "isInChatRoom",
    "chat_room_notify",
    "chatRoomNotify",
]


def pick_column(columns, names):
    for name in names:
        if name in columns:
            return name
    return None


def sql_expr(columns, output_name):
    column = pick_column(columns, CONTACT_FIELDS[output_name])
    return f'"{column}" AS "{output_name}"' if column else f'NULL AS "{output_name}"'


def table_columns(connection, table):
    return {row[1] for row in connection.execute(f'PRAGMA table_info("{table}")')}


def find_contact_table(connection):
    rows = connection.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    names = [row[0] for row in rows]
    for name in ["contact", "Contact", "contacts"]:
        if name in names:
            return name
    return ""


def read_contacts(db_path):
    db_uri = f"{Path(db_path).resolve().as_uri()}?mode=ro"
    connection = sqlite3.connect(db_uri, uri=True)
    connection.row_factory = sqlite3.Row
    try:
        table = find_contact_table(connection)
        if not table:
            raise RuntimeError("contact table not found")

        columns = table_columns(connection, table)
        select_list = ", ".join(sql_expr(columns, field) for field in CONTACT_FIELDS)
        rows = connection.execute(f'SELECT {select_list} FROM "{table}"').fetchall()
        return [dict(row) for row in rows]
    finally:
        connection.close()


def value_counts(connection, table, column):
    rows = connection.execute(
        f'SELECT "{column}" AS value, COUNT(*) AS count FROM "{table}" GROUP BY "{column}" ORDER BY count DESC LIMIT 20'
    ).fetchall()
    return [{"value": "" if row["value"] is None else str(row["value"]), "count": row["count"]} for row in rows]


def count_where(connection, table, clauses):
    where = " AND ".join(clauses) if clauses else "1=1"
    return connection.execute(f'SELECT COUNT(*) AS count FROM "{table}" WHERE {where}').fetchone()["count"]


def non_empty_clause(column):
    return f'"{column}" IS NOT NULL AND TRIM(CAST("{column}" AS TEXT)) != ""'


def safe_like_lower(column):
    return f'LOWER(CAST("{column}" AS TEXT))'


def inspect_contacts(db_path):
    db_uri = f"{Path(db_path).resolve().as_uri()}?mode=ro"
    connection = sqlite3.connect(db_uri, uri=True)
    connection.row_factory = sqlite3.Row
    try:
        table = find_contact_table(connection)
        if not table:
            raise RuntimeError("contact table not found")

        columns = sorted(table_columns(connection, table))
        row_count = connection.execute(f'SELECT COUNT(*) AS count FROM "{table}"').fetchone()["count"]
        picked = {
            field: pick_column(set(columns), names)
            for field, names in CONTACT_FIELDS.items()
        }
        non_empty = {}
        for field, column in picked.items():
            if not column:
                non_empty[field] = 0
                continue
            non_empty[field] = connection.execute(
                f'SELECT COUNT(*) AS count FROM "{table}" WHERE "{column}" IS NOT NULL AND TRIM(CAST("{column}" AS TEXT)) != ""'
            ).fetchone()["count"]

        counts = {}
        for column in INSPECT_VALUE_FIELDS:
            if column in columns and column not in counts:
                counts[column] = value_counts(connection, table, column)

        local_column = picked.get("local_type")
        username_column = picked.get("username")
        alias_column = picked.get("alias")
        remark_column = picked.get("remark")
        nickname_column = picked.get("nick_name")
        verify_column = picked.get("verify_flag")
        room_column = picked.get("chat_room_type")
        delete_column = picked.get("delete_flag")
        is_in_room_column = "is_in_chat_room" if "is_in_chat_room" in columns else None

        base_clauses = []
        if username_column:
            lower_username = safe_like_lower(username_column)
            base_clauses += [
                non_empty_clause(username_column),
                f'{lower_username} NOT LIKE "%@chatroom"',
                f'{lower_username} NOT LIKE "gh_%"',
                f'{lower_username} NOT LIKE "openim_%"',
                f'{lower_username} NOT LIKE "%@openim%"',
                f'{lower_username} NOT IN ("weixin","filehelper","notifymessage","fmessage","medianote","floatbottle")',
            ]
        if verify_column:
            base_clauses.append(f'CAST("{verify_column}" AS INTEGER) = 0')
        if room_column:
            base_clauses.append(f'CAST("{room_column}" AS INTEGER) = 0')
        if delete_column:
            base_clauses.append(f'CAST("{delete_column}" AS INTEGER) = 0')

        name_clause_parts = [non_empty_clause(column) for column in [remark_column, nickname_column, alias_column] if column]
        if name_clause_parts:
            base_clauses.append("(" + " OR ".join(name_clause_parts) + ")")

        candidate_counts = {
            "base": count_where(connection, table, base_clauses),
        }
        if local_column:
            candidate_counts["base_local_type_1"] = count_where(
                connection, table, [*base_clauses, f'CAST("{local_column}" AS INTEGER) = 1']
            )
            candidate_counts["base_local_type_3"] = count_where(
                connection, table, [*base_clauses, f'CAST("{local_column}" AS INTEGER) = 3']
            )
        if local_column and is_in_room_column:
            candidate_counts["base_local_type_1_not_in_room"] = count_where(
                connection,
                table,
                [*base_clauses, f'CAST("{local_column}" AS INTEGER) = 1', f'CAST("{is_in_room_column}" AS INTEGER) = 0'],
            )

        local_breakdown = []
        if local_column:
            for row in connection.execute(
                f'SELECT "{local_column}" AS value, COUNT(*) AS count FROM "{table}" GROUP BY "{local_column}" ORDER BY count DESC'
            ).fetchall():
                value = "" if row["value"] is None else str(row["value"])
                clauses = [f'CAST("{local_column}" AS TEXT) = ?']
                params = [value]
                def local_count(extra_clause):
                    return connection.execute(
                        f'SELECT COUNT(*) AS count FROM "{table}" WHERE {" AND ".join([*clauses, extra_clause])}',
                        params,
                    ).fetchone()["count"]

                local_breakdown.append({
                    "value": value,
                    "count": row["count"],
                    "alias": local_count(non_empty_clause(alias_column)) if alias_column else 0,
                    "remark": local_count(non_empty_clause(remark_column)) if remark_column else 0,
                    "nickname": local_count(non_empty_clause(nickname_column)) if nickname_column else 0,
                    "wxid": local_count(f'{safe_like_lower(username_column)} LIKE "wxid_%"') if username_column else 0,
                    "chatroom": local_count(f'{safe_like_lower(username_column)} LIKE "%@chatroom"') if username_column else 0,
                    "gh": local_count(f'{safe_like_lower(username_column)} LIKE "gh_%"') if username_column else 0,
                })

        return {
            "table": table,
            "row_count": row_count,
            "columns": columns,
            "picked_columns": picked,
            "non_empty": non_empty,
            "value_counts": counts,
            "candidate_counts": candidate_counts,
            "local_breakdown": local_breakdown,
        }
    finally:
        connection.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--contact-db", required=True)
    parser.add_argument("--key-info")
    parser.add_argument("--out", required=True)
    parser.add_argument("--inspect", action="store_true")
    args = parser.parse_args()

    if not os.path.exists(args.contact_db):
        print("contact_db_missing", file=sys.stderr)
        return 2
    if args.key_info and not os.path.exists(args.key_info):
        print("key_info_missing", file=sys.stderr)
        return 2

    try:
        payload = inspect_contacts(args.contact_db) if args.inspect else read_contacts(args.contact_db)
    except Exception:
        # ponytail: this dev helper only reads already-decrypted SQLite; ship a real decrypt binary here for encrypted WeChat DBs.
        print("contact_db_read_failed", file=sys.stderr)
        return 3

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as file:
        json.dump(payload, file, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
