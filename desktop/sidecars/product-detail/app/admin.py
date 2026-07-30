"""
管理后台蓝图：用户管理 / 生成记录 / 使用量统计
"""
from flask import Blueprint, render_template, redirect, url_for, request, flash, abort
from flask_login import login_required, current_user
from sqlalchemy import func
from extensions import db
from models import User, GenerationLog
from datetime import datetime, timedelta

admin_bp = Blueprint("admin", __name__, url_prefix="/admin")


@admin_bp.before_request
@login_required
def admin_required():
    if not current_user.is_admin:
        abort(403)


@admin_bp.route("/")
def admin_index():
    return redirect(url_for("admin.users"))


# ── 用户管理 ──
@admin_bp.route("/users")
def users():
    all_users = User.query.order_by(User.created_at.desc()).all()
    return render_template("admin/users.html", users=all_users)


@admin_bp.route("/users/<int:uid>/approve", methods=["POST"])
def approve_user(uid):
    u = db.session.get(User, uid)
    if u:
        u.is_approved = True
        db.session.commit()
        flash(f"已审核通过 {u.username}", "success")
    return redirect(url_for("admin.users"))


@admin_bp.route("/users/<int:uid>/reject", methods=["POST"])
def reject_user(uid):
    u = db.session.get(User, uid)
    if u:
        u.is_approved = False
        db.session.commit()
        flash(f"已拒绝 {u.username}", "info")
    return redirect(url_for("admin.users"))


@admin_bp.route("/users/<int:uid>/toggle-paid", methods=["POST"])
def toggle_paid(uid):
    u = db.session.get(User, uid)
    if u:
        u.is_paid = not u.is_paid
        db.session.commit()
        status = "已付费" if u.is_paid else "未付费"
        flash(f"{u.username} 已标记为{status}", "success")
    return redirect(url_for("admin.users"))


@admin_bp.route("/users/<int:uid>/toggle-admin", methods=["POST"])
def toggle_admin(uid):
    u = db.session.get(User, uid)
    if u and u.id != current_user.id:
        u.is_admin = not u.is_admin
        db.session.commit()
        status = "管理员" if u.is_admin else "普通用户"
        flash(f"{u.username} 已设为{status}", "success")
    return redirect(url_for("admin.users"))


@admin_bp.route("/users/<int:uid>/delete", methods=["POST"])
def delete_user(uid):
    u = db.session.get(User, uid)
    if u and u.id != current_user.id:
        db.session.delete(u)
        db.session.commit()
        flash(f"已删除用户 {u.username}", "info")
    return redirect(url_for("admin.users"))


# ── 生成记录 ──
@admin_bp.route("/logs")
def logs():
    page = request.args.get("page", 1, type=int)
    username = request.args.get("username", "").strip()

    query = db.session.query(GenerationLog, User.username).join(User)
    if username:
        query = query.filter(User.username.contains(username))
    query = query.order_by(GenerationLog.created_at.desc())

    pagination = query.paginate(page=page, per_page=50, error_out=False)
    return render_template("admin/logs.html", pagination=pagination, search_username=username)


# ── 使用量统计 ──
@admin_bp.route("/stats")
def stats():
    now = datetime.utcnow()
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    week_start = today_start - timedelta(days=now.weekday())
    month_start = today_start.replace(day=1)

    # 用户统计：1 次查询
    user_stats = db.session.query(
        func.count(User.id),
        func.sum(db.case((User.is_approved == True, 1), else_=0)),
        func.sum(db.case((User.is_paid == True, 1), else_=0)),
        func.sum(db.case((User.is_approved == False, 1), else_=0)),
    ).one()
    total_users, approved_users, paid_users, pending_users = (
        user_stats[0], int(user_stats[1] or 0), int(user_stats[2] or 0), int(user_stats[3] or 0)
    )

    # 日志统计：1 次查询
    log_stats = db.session.query(
        func.count(GenerationLog.id),
        func.sum(db.case((GenerationLog.created_at >= today_start, 1), else_=0)),
        func.sum(db.case((GenerationLog.created_at >= week_start, 1), else_=0)),
        func.sum(db.case((GenerationLog.created_at >= month_start, 1), else_=0)),
        func.sum(db.case((GenerationLog.api_key_source == "platform", 1), else_=0)),
        func.sum(db.case((GenerationLog.api_key_source == "custom", 1), else_=0)),
    ).one()
    total_logs = log_stats[0]
    today_logs, week_logs, month_logs = int(log_stats[1] or 0), int(log_stats[2] or 0), int(log_stats[3] or 0)
    platform_calls, custom_calls = int(log_stats[4] or 0), int(log_stats[5] or 0)

    # 每个用户的使用量排行
    user_usage = (
        db.session.query(User.username, func.count(GenerationLog.id).label("count"))
        .join(GenerationLog)
        .group_by(User.id)
        .order_by(func.count(GenerationLog.id).desc())
        .limit(20)
        .all()
    )

    return render_template("admin/stats.html",
        total_users=total_users, approved_users=approved_users,
        paid_users=paid_users, pending_users=pending_users,
        total_logs=total_logs, today_logs=today_logs,
        week_logs=week_logs, month_logs=month_logs,
        platform_calls=platform_calls, custom_calls=custom_calls,
        user_usage=user_usage,
    )
