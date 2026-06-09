import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import './App.css';

const API_BASE = process.env.REACT_APP_API_URL || 'http://localhost:3000/api';

function App() {
  const [sessionId, setSessionId] = useState(null);
  const [userId, setUserId] = useState(null);
  const [conversationId, setConversationId] = useState(null);
  const [conversations, setConversations] = useState([]);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [selectedModel, setSelectedModel] = useState('openrouter/auto');
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState(null);
  const messagesEndRef = useRef(null);

  // Initialize session on mount
  useEffect(() => {
    initializeSession();
  }, []);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const initializeSession = async () => {
    try {
      const response = await axios.post(`${API_BASE}/session/init`);
      setSessionId(response.data.sessionId);
      setUserId(response.data.userId);
      
      // Create initial conversation
      const convResponse = await axios.post(`${API_BASE}/conversations`, {
        userId: response.data.userId,
        title: 'New Chat'
      });
      setConversationId(convResponse.data.id);
      
      // Fetch models
      const modelsResponse = await axios.get(`${API_BASE}/models`);
      setModels(modelsResponse.data);
      
      // Fetch stats
      fetchStats(response.data.userId);
    } catch (err) {
      console.error('Failed to initialize session:', err);
    }
  };

  const fetchStats = async (uid) => {
    try {
      const response = await axios.get(`${API_BASE}/stats/${uid}`);
      setStats(response.data);
    } catch (err) {
      console.error('Failed to fetch stats:', err);
    }
  };

  const handleSendMessage = async (e) => {
    e.preventDefault();
    if (!input.trim() || !conversationId || !userId) return;

    const userMessage = input;
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: userMessage }]);
    setLoading(true);

    try {
      let assistantMessage = '';
      
      const response = await axios.post(`${API_BASE}/chat`, {
        conversationId,
        userId,
        message: userMessage,
        model: selectedModel
      }, {
        responseType: 'stream'
      });

      return new Promise((resolve, reject) => {
        const reader = response.data.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        const read = async () => {
          try {
            const { done, value } = await reader.read();
            if (done) {
              if (assistantMessage) {
                setMessages(prev => [...prev, { role: 'assistant', content: assistantMessage }]);
              }
              setLoading(false);
              fetchStats(userId);
              resolve();
              return;
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n\n');
            buffer = lines.pop();

            for (const line of lines) {
              if (line.startsWith('data: ')) {
                try {
                  const data = JSON.parse(line.slice(6));
                  if (data.content) {
                    assistantMessage += data.content;
                    setMessages(prev => {
                      const last = prev[prev.length - 1];
                      if (last?.role === 'assistant') {
                        return [
                          ...prev.slice(0, -1),
                          { role: 'assistant', content: assistantMessage }
                        ];
                      }
                      return [...prev, { role: 'assistant', content: data.content }];
                    });
                  }
                } catch (e) {
                  // Ignore parse errors
                }
              }
            }

            read();
          } catch (err) {
            reject(err);
          }
        };

        read();
      });
    } catch (err) {
      console.error('Failed to send message:', err);
      setMessages(prev => [...prev, { role: 'assistant', content: '❌ Error: Failed to get response' }]);
      setLoading(false);
    }
  };

  const startNewConversation = async () => {
    if (!userId) return;
    try {
      const response = await axios.post(`${API_BASE}/conversations`, {
        userId,
        title: 'New Chat'
      });
      setConversationId(response.data.id);
      setMessages([]);
    } catch (err) {
      console.error('Failed to create conversation:', err);
    }
  };

  return (
    <div className="container">
      <div className="sidebar">
        <div className="logo">
          <h1>🤖 AI Agent</h1>
          <p>Powered by OpenRouter</p>
        </div>
        
        <button className="new-chat-btn" onClick={startNewConversation}>
          + New Chat
        </button>

        <div className="model-selector">
          <label>Model:</label>
          <select value={selectedModel} onChange={(e) => setSelectedModel(e.target.value)}>
            {models.map(model => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))}
          </select>
        </div>

        {stats && (
          <div className="stats">
            <h3>📊 Your Stats</h3>
            <div className="stat-item">
              <span>Messages:</span>
              <strong>{stats.total_messages}</strong>
            </div>
            <div className="stat-item">
              <span>Tokens Used:</span>
              <strong>{stats.total_output_tokens}</strong>
            </div>
            <div className="stat-item">
              <span>Avg Response:</span>
              <strong>{stats.avg_response_time_ms}ms</strong>
            </div>
            <div className="stat-item">
              <span>Active Days:</span>
              <strong>{stats.active_days}</strong>
            </div>
          </div>
        )}
      </div>

      <div className="chat-container">
        <div className="messages">
          {messages.length === 0 ? (
            <div className="welcome">
              <h2>Welcome to AI Agent! 👋</h2>
              <p>Start a conversation with any of our powerful AI models</p>
              <ul>
                <li>💬 Ask questions</li>
                <li>💻 Get coding help</li>
                <li>📝 Brainstorm ideas</li>
                <li>🔍 Get answers instantly</li>
              </ul>
            </div>
          ) : (
            messages.map((msg, idx) => (
              <div key={idx} className={`message ${msg.role}`}>
                <div className="message-content">{msg.content}</div>
              </div>
            ))
          )}
          {loading && (
            <div className="message assistant">
              <div className="message-content">⏳ Typing...</div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <form className="input-form" onSubmit={handleSendMessage}>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask me anything..."
            disabled={loading}
          />
          <button type="submit" disabled={loading || !input.trim()}>
            {loading ? '⏳' : '🚀'}
          </button>
        </form>
      </div>
    </div>
  );
}

export default App;