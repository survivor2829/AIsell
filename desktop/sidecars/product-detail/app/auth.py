"""
用户认证蓝图：登录 / 注册 / 登出
"""
from urllib.parse import urlparse
from flask import Blueprint, render_template, redirect, url_for, request, flash
from flask_login import login_user, logout_user, login_required, current_user
from extensions import db, limiter
from models import User

auth_bp = Blueprint("auth", __name__, url_prefix="/auth")


@auth_bp.route("/login", methods=["GET", "POST"])
@limiter.limit("5 per minute; 20 per hour", methods=["POST"])
def login():
    if current_user.is_authenticated:
        return redirect(url_for("index"))

    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")

        user = User.query.filter_by(username=username).first()
        if not user or not user.check_password(password):
            flash("用户名或密码错误", "error")
            return render_template("auth/login.html")

        if not user.is_approved:
            flash("您的账号正在等待管理员审核，审核通过后即可登录", "warning")
            return render_template("auth/login.html")

        login_user(user, remember=True)
        next_page = request.args.get("next")
        if next_page and urlparse(next_page).netloc:
            next_page = None
        return redirect(next_page or url_for("index"))

    return render_template("auth/login.html")


@auth_bp.route("/register", methods=["GET", "POST"])
def register():
    if current_user.is_authenticated:
        return redirect(url_for("index"))

    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        password2 = request.form.get("password2", "")
        email = request.form.get("email", "").strip() or None

        if not username or not password:
            flash("用户名和密码不能为空", "error")
            return render_template("auth/register.html")

        if len(password) < 6:
            flash("密码至少6个字符", "error")
            return render_template("auth/register.html")

        if password != password2:
            flash("两次密码输入不一致", "error")
            return render_template("auth/register.html")

        if User.query.filter_by(username=username).first():
            flash("该用户名已被注册", "error")
            return render_template("auth/register.html")

        if email and User.query.filter_by(email=email).first():
            flash("该邮箱已被注册", "error")
            return render_template("auth/register.html")

        user = User(username=username, email=email)
        user.set_password(password)
        db.session.add(user)
        db.session.commit()

        flash("注册成功！请等待管理员审核后即可登录", "success")
        return redirect(url_for("auth.login"))

    return render_template("auth/register.html")


@auth_bp.route("/logout", methods=["POST"])
@login_required
def logout():
    logout_user()
    flash("已退出登录", "info")
    return redirect(url_for("auth.login"))
