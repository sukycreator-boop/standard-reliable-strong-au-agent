# 🚀 Deployment Guide - Render

This guide will help you deploy the AI Agent to **Render.com** with your existing OpenRouter API key.

---

## **✅ Prerequisites**
- ✅ GitHub account with this repository
- ✅ Render account (free at https://render.com)
- ✅ OpenRouter API key (already in your Render environment)

---

## **📋 Step 1: Create PostgreSQL Database on Render**

1. Go to **[Render Dashboard](https://dashboard.render.com/)**
2. Click **"New"** → **"PostgreSQL"**
3. Fill in the form:
   - **Name:** `ai-agent-db`
   - **Database:** `aiagent`
   - **User:** `aiagent_user`
   - **Region:** Choose closest to you
   - **Plan:** Free tier
4. Click **"Create Database"**
5. **Wait for it to finish** (5-10 minutes)
6. Once ready, copy the **"Internal Database URL"** (looks like: `postgresql://user:password@localhost:5432/dbname`)

---

## **🖥️ Step 2: Deploy Node.js Backend**

1. From Render Dashboard, click **"New"** → **"Web Service"**
2. Click **"Connect a repository"** and select:
   - Owner: `sukycreator-boop`
   - Repo: `standard-reliable-strong-au-agent`
3. Fill in the form:
   - **Name:** `ai-agent-backend`
   - **Runtime:** Node
   - **Region:** Same as database
   - **Branch:** main
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`

4. Click **"Advanced"** and add Environment Variables:
   ```
   NODE_ENV=production
   PORT=3000
   OPENROUTER_API_KEY=your_existing_key_here
   ```

5. Scroll down → **"Create Web Service"**

6. **Wait for deployment** (2-3 minutes)

---

## **🔗 Step 3: Link Database to Backend**

1. In your Web Service settings, go to **"Environment"**
2. Click **"Add Environment"** → Link your PostgreSQL instance
3. Render will auto-inject `DATABASE_URL`
4. Or manually add:
   ```
   DATABASE_URL=postgresql://user:password@host:5432/dbname
   ```

---

## **🎨 Step 4: Deploy React Frontend (Optional)**

### Option A: Deploy to Vercel (Easiest)
1. Go to **[Vercel](https://vercel.com)**
2. Click **"Import Project"** → select your GitHub repo
3. Set environment variable:
   ```
   REACT_APP_API_URL=https://your-ai-agent-backend.onrender.com/api
   ```
4. Click **"Deploy"**

### Option B: Deploy to Render as Static Site
1. In your repo, go to **frontend** directory
2. Run: `npm run build`
3. Render Dashboard → **"New"** → **"Static Site"**
4. Connect repo and set:
   - **Build Command:** `cd frontend && npm run build`
   - **Publish Directory:** `frontend/build`

---

## **🧪 Step 5: Test Your Deployment**

1. Get your backend URL from Render (e.g., `https://ai-agent-backend.onrender.com`)
2. Test the API:
   ```bash
   curl https://ai-agent-backend.onrender.com/api/health
   ```
   Expected response: `{"status":"ok"}`

3. Test chat endpoint:
   ```bash
   curl -X POST https://ai-agent-backend.onrender.com/api/session/init
   ```

4. If frontend is deployed, visit it in your browser

---

## **📊 Monitoring & Logs**

1. **View Logs:** Render Dashboard → Your Service → **"Logs"**
2. **Monitor Performance:** Render Dashboard → **"Metrics"**
3. **Check Database:** Render Dashboard → Your Database → **"Data Browser"**

---

## **⚙️ Environment Variables Reference**

| Variable | Value | Required |
|----------|-------|----------|
| `OPENROUTER_API_KEY` | Your OpenRouter API key | ✅ Yes |
| `DATABASE_URL` | PostgreSQL connection string | ✅ Yes |
| `NODE_ENV` | `production` | ✅ Yes |
| `PORT` | `3000` | ✅ Yes |
| `APP_URL` | Your deployed URL | ✅ Yes |

---

## **🐛 Troubleshooting**

### Database connection errors
- Check `DATABASE_URL` is correct
- Verify database is running
- Check PostgreSQL is accessible from Render

### API key errors
- Verify `OPENROUTER_API_KEY` is set
- Check key has proper permissions
- Test key locally first

### Frontend can't reach backend
- Ensure `REACT_APP_API_URL` includes `/api`
- Check CORS is enabled in backend
- Verify backend is running

### Out of memory
- Upgrade to paid plan
- Optimize database queries
- Implement caching

---

## **🎉 Success!**

Your AI Agent is now live! 🚀

- **Backend:** `https://your-service.onrender.com`
- **Frontend:** `https://your-frontend.vercel.app` (if deployed)
- **API Docs:** `/api/health`, `/api/models`, `/api/chat`

---

## **📞 Need Help?**

- [Render Docs](https://render.com/docs)
- [OpenRouter Docs](https://openrouter.ai/docs)
- GitHub Issues in this repo

---

**Deployment Complete! 🎊**
