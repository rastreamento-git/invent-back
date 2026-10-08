require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

// Conexão com o banco de dados (Aiven) com SSL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// ==========================================
// 1. PRODUTOS & EQUIPAMENTOS
// ==========================================
app.get('/api/produtos', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM produtos ORDER BY id');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar produtos.' });
  }
});

app.post('/api/produtos', async (req, res) => {
  const { nome, categoria, estoque_minimo } = req.body;
  try {
    await pool.query(
      'INSERT INTO produtos (nome, categoria, quantidade_matriz, estoque_minimo) VALUES ($1, $2, 0, $3)',
      [nome, categoria || 'RASTREADOR', estoque_minimo || 5]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao cadastrar equipamento.' });
  }
});

app.delete('/api/produtos/:id', async (req, res) => {
  try {
    const check = await pool.query('SELECT COUNT(*) FROM equipamentos_seriais WHERE produto_id = $1', [req.params.id]);
    if (check.rows[0].count > 0) return res.status(400).json({ error: 'Existem peças deste modelo registradas. Não é possível excluir.' });
    await pool.query('DELETE FROM produtos WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao excluir.' });
  }
});

// ==========================================
// 2. TÉCNICOS
// ==========================================
app.get('/api/tecnicos', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tecnicos WHERE ativo = true ORDER BY nome');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar técnicos.' });
  }
});

app.post('/api/tecnicos', async (req, res) => {
  try {
    await pool.query('INSERT INTO tecnicos (nome) VALUES ($1)', [req.body.nome]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao cadastrar técnico.' });
  }
});

app.delete('/api/tecnicos/:id', async (req, res) => {
  try {
    const stock = await pool.query('SELECT SUM(quantidade) as total FROM estoque_tecnicos WHERE tecnico_id = $1', [req.params.id]);
    if (stock.rows.length > 0 && stock.rows[0].total > 0) return res.status(400).json({ error: 'O técnico possui equipamentos na posse.' });
    await pool.query('UPDATE tecnicos SET ativo = false WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao remover.' });
  }
});

// ==========================================
// 3. MOVIMENTAÇÕES (IMEI E CÂMERA)
// ==========================================
app.post('/api/entrada', async (req, res) => {
  const { produto_id, seriais } = req.body;
  try {
    await pool.query('BEGIN');
    for (let imei of seriais) {
      await pool.query("INSERT INTO equipamentos_seriais (codigo_serial, produto_id, status) VALUES ($1, $2, 'MATRIZ') ON CONFLICT (codigo_serial) DO NOTHING", [imei, produto_id]);
    }
    await pool.query('UPDATE produtos SET quantidade_matriz = quantidade_matriz + $1 WHERE id = $2', [seriais.length, produto_id]);
    await pool.query("INSERT INTO movimentacoes (tipo, produto_id, quantidade) VALUES ('ENTRADA_MATRIZ', $1, $2)", [produto_id, seriais.length]);
    await pool.query('COMMIT');
    res.json({ success: true });
  } catch (e) {
    await pool.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/transferir', async (req, res) => {
  const { tecnico_id, produto_id, seriais } = req.body;
  try {
    await pool.query('BEGIN');
    let transferidos = 0;
    for (let imei of seriais) {
      const result = await pool.query("UPDATE equipamentos_seriais SET status = 'TECNICO', tecnico_id = $1 WHERE codigo_serial = $2 AND status = 'MATRIZ' RETURNING codigo_serial", [tecnico_id, imei]);
      if (result.rowCount > 0) transferidos++;
    }
    if (transferidos === 0) throw new Error('Nenhum IMEI disponível na Matriz.');
    await pool.query('UPDATE produtos SET quantidade_matriz = quantidade_matriz - $1 WHERE id = $2', [transferidos, produto_id]);
    await pool.query(`INSERT INTO estoque_tecnicos (tecnico_id, produto_id, quantidade) VALUES ($1, $2, $3) ON CONFLICT (tecnico_id, produto_id) DO UPDATE SET quantidade = estoque_tecnicos.quantidade + $3`, [tecnico_id, produto_id, transferidos]);
    await pool.query("INSERT INTO movimentacoes (tipo, produto_id, tecnico_id, quantidade) VALUES ('CARGA_TECNICO', $1, $2, $3)", [produto_id, tecnico_id, transferidos]);
    await pool.query('COMMIT');
    res.json({ success: true, transferidos });
  } catch (e) {
    await pool.query('ROLLBACK');
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/instalar', async (req, res) => {
  const { tecnico_id, produto_id, seriais } = req.body;
  try {
    await pool.query('BEGIN');
    let instalados = 0;
    for (let imei of seriais) {
      const result = await pool.query("UPDATE equipamentos_seriais SET status = 'INSTALADO', data_atualizacao = CURRENT_TIMESTAMP WHERE codigo_serial = $1 AND tecnico_id = $2 AND status = 'TECNICO' RETURNING codigo_serial", [imei, tecnico_id]);
      if (result.rowCount > 0) instalados++;
    }
    if (instalados === 0) throw new Error('Nenhum IMEI na posse deste técnico.');
    await pool.query('UPDATE estoque_tecnicos SET quantidade = quantidade - $1 WHERE tecnico_id = $2 AND produto_id = $3', [instalados, tecnico_id, produto_id]);
    await pool.query("INSERT INTO movimentacoes (tipo, produto_id, tecnico_id, quantidade) VALUES ('USO_FINAL', $1, $2, $3)", [produto_id, tecnico_id, instalados]);
    await pool.query('COMMIT');
    res.json({ success: true, instalados });
  } catch (e) {
    await pool.query('ROLLBACK');
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/estorno', async (req, res) => {
  const { tipo_estorno, produto_id, tecnico_id, seriais } = req.body;
  try {
    await pool.query('BEGIN');
    let estornados = 0;
    if (tipo_estorno === 'MATRIZ') {
      for (let imei of seriais) {
        const result = await pool.query("DELETE FROM equipamentos_seriais WHERE codigo_serial = $1 AND status = 'MATRIZ' RETURNING codigo_serial", [imei]);
        if (result.rowCount > 0) estornados++;
      }
      if (estornados > 0) {
        await pool.query('UPDATE produtos SET quantidade_matriz = quantidade_matriz - $1 WHERE id = $2', [estornados, produto_id]);
        await pool.query("INSERT INTO movimentacoes (tipo, produto_id, quantidade) VALUES ('ESTORNO_MATRIZ', $1, $2)", [produto_id, estornados]);
      }
    } else if (tipo_estorno === 'TECNICO') {
      for (let imei of seriais) {
        const result = await pool.query("UPDATE equipamentos_seriais SET status = 'MATRIZ', tecnico_id = NULL WHERE codigo_serial = $1 AND tecnico_id = $2 RETURNING codigo_serial", [imei, tecnico_id]);
        if (result.rowCount > 0) estornados++;
      }
      if (estornados > 0) {
        await pool.query('UPDATE estoque_tecnicos SET quantidade = quantidade - $1 WHERE tecnico_id = $2 AND produto_id = $3', [estornados, tecnico_id, produto_id]);
        await pool.query('UPDATE produtos SET quantidade_matriz = quantidade_matriz + $1 WHERE id = $2', [estornados, produto_id]);
        await pool.query("INSERT INTO movimentacoes (tipo, produto_id, tecnico_id, quantidade) VALUES ('DEVOLUCAO_TECNICO', $1, $2, $3)", [produto_id, tecnico_id, estornados]);
      }
    }
    if (estornados === 0) throw new Error('Nenhum IMEI válido para estorno.');
    await pool.query('COMMIT');
    res.json({ success: true, estornados });
  } catch (e) {
    await pool.query('ROLLBACK');
    res.status(400).json({ error: e.message });
  }
});

// ==========================================
// 4. TRIAGEM E RMA
// ==========================================
app.get('/api/imeis', async (req, res) => {
  try {
    const result = await pool.query(`SELECT e.codigo_serial, e.status, e.data_atualizacao, p.nome as produto, p.categoria, t.nome as tecnico FROM equipamentos_seriais e LEFT JOIN produtos p ON e.produto_id = p.id LEFT JOIN tecnicos t ON e.tecnico_id = t.id ORDER BY e.data_atualizacao DESC`);
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/triagem/receber', async (req, res) => {
  try {
    await pool.query('BEGIN');
    for (let imei of req.body.seriais) {
      await pool.query("UPDATE equipamentos_seriais SET status = 'TRIAGEM', tecnico_id = NULL, data_atualizacao = CURRENT_TIMESTAMP WHERE codigo_serial = $1", [imei]);
    }
    await pool.query('COMMIT');
    res.json({ success: true });
  } catch (e) { await pool.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
});

app.post('/api/triagem/avaliar', async (req, res) => {
  const { codigo_serial, aprovado, produto_id } = req.body;
  try {
    await pool.query('BEGIN');
    if (aprovado) {
      await pool.query("UPDATE equipamentos_seriais SET status = 'MATRIZ', data_atualizacao = CURRENT_TIMESTAMP WHERE codigo_serial = $1", [codigo_serial]);
      await pool.query('UPDATE produtos SET quantidade_matriz = quantidade_matriz + 1 WHERE id = $1', [produto_id]);
      await pool.query("INSERT INTO movimentacoes (tipo, produto_id, quantidade) VALUES ('REUSO_APROVADO', $1, 1)", [produto_id]);
    } else {
      await pool.query("UPDATE equipamentos_seriais SET status = 'SUCATA', data_atualizacao = CURRENT_TIMESTAMP WHERE codigo_serial = $1", [codigo_serial]);
    }
    await pool.query('COMMIT');
    res.json({ success: true });
  } catch (e) { await pool.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
});

app.delete('/api/limpeza-instalados', async (req, res) => {
  try {
    const result = await pool.query("DELETE FROM equipamentos_seriais WHERE status = 'INSTALADO' AND data_atualizacao < CURRENT_DATE - INTERVAL '30 days' RETURNING codigo_serial");
    res.json({ success: true, apagados: result.rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==========================================
// 5. CONSULTAS GERAIS
// ==========================================
app.get('/api/estoque-tecnicos', async (req, res) => {
  try {
    const result = await pool.query(`SELECT et.*, t.nome as tecnico_nome, t.estoque_minimo, p.nome as produto_nome, p.categoria FROM estoque_tecnicos et JOIN tecnicos t ON et.tecnico_id = t.id JOIN produtos p ON et.produto_id = p.id`);
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/logs', async (req, res) => {
  try {
    const result = await pool.query(`SELECT m.id, m.tipo, p.nome as produto, t.nome as tecnico, m.quantidade, m.data FROM movimentacoes m LEFT JOIN produtos p ON m.produto_id = p.id LEFT JOIN tecnicos t ON m.tecnico_id = t.id ORDER BY m.data DESC LIMIT 200`);
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/dashboard', async (req, res) => {
  try {
    const kpis = await pool.query(`SELECT COALESCE(SUM(CASE WHEN data >= CURRENT_DATE THEN quantidade ELSE 0 END), 0) as diario, COALESCE(SUM(CASE WHEN data >= date_trunc('week', CURRENT_DATE) THEN quantidade ELSE 0 END), 0) as semanal, COALESCE(SUM(CASE WHEN data >= date_trunc('month', CURRENT_DATE) THEN quantidade ELSE 0 END), 0) as mensal, COALESCE(SUM(CASE WHEN data >= date_trunc('quarter', CURRENT_DATE) THEN quantidade ELSE 0 END), 0) as trimestral FROM movimentacoes WHERE tipo = 'USO_FINAL'`);
    const grafico = await pool.query(`SELECT TO_CHAR(data, 'DD/MM') as dia, SUM(quantidade) as instalacoes FROM movimentacoes WHERE tipo = 'USO_FINAL' AND data >= CURRENT_DATE - INTERVAL '6 days' GROUP BY TO_CHAR(data, 'DD/MM'), DATE(data) ORDER BY DATE(data) ASC`);
    const mediaTecnicos = await pool.query(`SELECT t.nome, COALESCE(SUM(m.quantidade), 0) as total_mes, ROUND(COALESCE(SUM(m.quantidade), 0) / 30.0, 2) as media_diaria FROM tecnicos t LEFT JOIN movimentacoes m ON t.id = m.tecnico_id AND m.tipo = 'USO_FINAL' AND m.data >= CURRENT_DATE - INTERVAL '30 days' GROUP BY t.id, t.nome ORDER BY total_mes DESC`);
    res.json({ kpis: kpis.rows[0], grafico: grafico.rows, tecnicos: mediaTecnicos.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/previsao-compras', async (req, res) => {
  try {
    const result = await pool.query(`SELECT p.id, p.nome, p.quantidade_matriz, COALESCE(SUM(m.quantidade), 0) as uso_30_dias FROM produtos p LEFT JOIN movimentacoes m ON p.id = m.produto_id AND m.tipo = 'USO_FINAL' AND m.data >= CURRENT_DATE - INTERVAL '30 days' GROUP BY p.id`);
    const previsao = result.rows.map(prod => {
      const cmd = Number(prod.uso_30_dias) / 30;
      const ponto_pedido = Math.ceil((cmd * 15) + (cmd * 7.5));
      const sugerido = Math.max(0, (Math.ceil(cmd * 45) + (cmd * 7.5)) - Number(prod.quantidade_matriz));
      return { ...prod, cmd: cmd.toFixed(2), ponto_pedido, sugerido, status: Number(prod.quantidade_matriz) <= ponto_pedido ? 'URGENTE' : 'OK' };
    });
    res.json(previsao);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/configurar-alerta', async (req, res) => {
  const { tipo, id, novo_limite } = req.body;
  try {
    if (tipo === 'PRODUTO') await pool.query('UPDATE produtos SET estoque_minimo = $1 WHERE id = $2', [novo_limite, id]);
    if (tipo === 'TECNICO') await pool.query('UPDATE tecnicos SET estoque_minimo = $1 WHERE id = $2', [novo_limite, id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
