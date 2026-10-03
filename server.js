require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ==========================================
// 1. PRODUTOS & TÉCNICOS
// ==========================================
app.get('/api/produtos', async (req, res) => {
    const result = await pool.query('SELECT * FROM produtos ORDER BY id');
    res.json(result.rows);
});

app.get('/api/tecnicos', async (req, res) => {
    // Retorna apenas técnicos que não foram excluídos (ativo = true)
    const result = await pool.query('SELECT * FROM tecnicos WHERE ativo = true ORDER BY nome');
    res.json(result.rows);
});

app.post('/api/tecnicos', async (req, res) => {
    await pool.query('INSERT INTO tecnicos (nome) VALUES ($1)', [req.body.nome]);
    res.json({ success: true });
});

// Soft Delete de Técnico com Trava de Segurança
app.delete('/api/tecnicos/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const stock = await pool.query('SELECT SUM(quantidade) as total FROM estoque_tecnicos WHERE tecnico_id = $1', [id]);
        if (stock.rows.length > 0 && stock.rows[0].total > 0) {
            return res.status(400).json({ error: 'O técnico possui equipamentos no estoque e não pode ser removido.' });
        }
        
        await pool.query('UPDATE tecnicos SET ativo = false WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao remover técnico.' });
    }
});

// ==========================================
// 2. CONSULTAS DE ESTOQUE E LOGS
// ==========================================
app.get('/api/estoque-tecnicos', async (req, res) => {
    const query = `
        SELECT et.*, t.nome as tecnico_nome, t.estoque_minimo, p.nome as produto_nome
        FROM estoque_tecnicos et
        JOIN tecnicos t ON et.tecnico_id = t.id
        JOIN produtos p ON et.produto_id = p.id
    `;
    const result = await pool.query(query);
    res.json(result.rows);
});

app.get('/api/logs', async (req, res) => {
    const result = await pool.query(`
        SELECT m.id, m.tipo, p.nome as produto, t.nome as tecnico, m.quantidade, m.data 
        FROM movimentacoes m 
        LEFT JOIN produtos p ON m.produto_id = p.id 
        LEFT JOIN tecnicos t ON m.tecnico_id = t.id 
        ORDER BY m.data DESC LIMIT 200
    `);
    res.json(result.rows);
});

// ==========================================
// 3. INTELIGÊNCIA: DASHBOARD & COMPRAS
// ==========================================
app.get('/api/dashboard', async (req, res) => {
    try {
        const kpis = await pool.query(`
            SELECT 
                COALESCE(SUM(CASE WHEN data >= CURRENT_DATE THEN quantidade ELSE 0 END), 0) as diario,
                COALESCE(SUM(CASE WHEN data >= date_trunc('week', CURRENT_DATE) THEN quantidade ELSE 0 END), 0) as semanal,
                COALESCE(SUM(CASE WHEN data >= date_trunc('month', CURRENT_DATE) THEN quantidade ELSE 0 END), 0) as mensal,
                COALESCE(SUM(CASE WHEN data >= date_trunc('quarter', CURRENT_DATE) THEN quantidade ELSE 0 END), 0) as trimestral
            FROM movimentacoes WHERE tipo = 'USO_FINAL'
        `);

        const grafico = await pool.query(`
            SELECT TO_CHAR(data, 'DD/MM') as dia, SUM(quantidade) as instalacoes
            FROM movimentacoes 
            WHERE tipo = 'USO_FINAL' AND data >= CURRENT_DATE - INTERVAL '6 days'
            GROUP BY TO_CHAR(data, 'DD/MM'), DATE(data)
            ORDER BY DATE(data) ASC
        `);

        const mediaTecnicos = await pool.query(`
            SELECT t.nome, COALESCE(SUM(m.quantidade), 0) as total_mes, ROUND(COALESCE(SUM(m.quantidade), 0) / 30.0, 2) as media_diaria
            FROM tecnicos t
            LEFT JOIN movimentacoes m ON t.id = m.tecnico_id AND m.tipo = 'USO_FINAL' AND m.data >= CURRENT_DATE - INTERVAL '30 days'
            GROUP BY t.id, t.nome
            ORDER BY total_mes DESC
        `);

        res.json({ kpis: kpis.rows[0], grafico: grafico.rows, tecnicos: mediaTecnicos.rows });
    } catch (error) { res.status(500).json({ error: 'Erro no dashboard' }); }
});

app.get('/api/previsao-compras', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT p.id, p.nome, p.quantidade_matriz, COALESCE(SUM(m.quantidade), 0) as uso_30_dias
            FROM produtos p
            LEFT JOIN movimentacoes m ON p.id = m.produto_id AND m.tipo = 'USO_FINAL' AND m.data >= CURRENT_DATE - INTERVAL '30 days'
            GROUP BY p.id
        `);
        
        const previsao = result.rows.map(prod => {
            const cmd = Number(prod.uso_30_dias) / 30; // Consumo Médio Diário
            const tr = 15; // Lead Time (15 dias)
            const es = Math.ceil(cmd * (tr / 2)); // Estoque de Segurança
            const ponto_pedido = Math.ceil((cmd * tr) + es);
            
            const estoque_alvo = Math.ceil(cmd * 45) + es; // Meta para 45 dias
            let sugerido = estoque_alvo - Number(prod.quantidade_matriz);
            if (sugerido < 0) sugerido = 0;

            return {
                ...prod, cmd: cmd.toFixed(2), ponto_pedido, estoque_alvo, sugerido,
                status: Number(prod.quantidade_matriz) <= ponto_pedido ? 'URGENTE' : 'OK'
            };
        });
        res.json(previsao);
    } catch (error) { res.status(500).json({ error: 'Erro ao gerar previsao' }); }
});

// ==========================================
// 4. CONFIGURAÇÕES & ESTORNOS
// ==========================================
app.put('/api/configurar-alerta', async (req, res) => {
    const { tipo, id, novo_limite } = req.body;
    if (tipo === 'PRODUTO') await pool.query('UPDATE produtos SET estoque_minimo = $1 WHERE id = $2', [novo_limite, id]);
    if (tipo === 'TECNICO') await pool.query('UPDATE tecnicos SET estoque_minimo = $1 WHERE id = $2', [novo_limite, id]);
    res.json({ success: true });
});

app.post('/api/estorno', async (req, res) => {
    const { tipo_estorno, produto_id, tecnico_id, quantidade } = req.body;
    try {
        await pool.query('BEGIN');
        if (tipo_estorno === 'MATRIZ') {
            await pool.query('UPDATE produtos SET quantidade_matriz = quantidade_matriz - $1 WHERE id = $2', [quantidade, produto_id]);
            await pool.query("INSERT INTO movimentacoes (tipo, produto_id, quantidade) VALUES ('ESTORNO_MATRIZ', $1, $2)", [produto_id, quantidade]);
        } else if (tipo_estorno === 'TECNICO') {
            await pool.query('UPDATE estoque_tecnicos SET quantidade = quantidade - $1 WHERE tecnico_id = $2 AND produto_id = $3', [quantidade, tecnico_id, produto_id]);
            await pool.query("INSERT INTO movimentacoes (tipo, produto_id, tecnico_id, quantidade) VALUES ('ESTORNO_TECNICO', $1, $2, $3)", [produto_id, tecnico_id, quantidade]);
        }
        await pool.query('COMMIT');
        res.json({ success: true });
    } catch (e) { await pool.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
});

// ==========================================
// 5. MOVIMENTAÇÕES SERIALIZADAS (COM IMEI/QR)
// ==========================================
app.post('/api/entrada', async (req, res) => {
    const { produto_id, seriais } = req.body; 
    try {
        await pool.query('BEGIN');
        for (let imei of seriais) {
            await pool.query(
                "INSERT INTO equipamentos_seriais (codigo_serial, produto_id, status) VALUES ($1, $2, 'MATRIZ') ON CONFLICT (codigo_serial) DO NOTHING", 
                [imei, produto_id]
            );
        }
        await pool.query('UPDATE produtos SET quantidade_matriz = quantidade_matriz + $1 WHERE id = $2', [seriais.length, produto_id]);
        await pool.query("INSERT INTO movimentacoes (tipo, produto_id, quantidade) VALUES ('ENTRADA_MATRIZ', $1, $2)", [produto_id, seriais.length]);
        await pool.query('COMMIT');
        res.json({ success: true });
    } catch (e) { await pool.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
});

app.post('/api/transferir', async (req, res) => {
    const { tecnico_id, produto_id, seriais } = req.body;
    try {
        await pool.query('BEGIN');
        for (let imei of seriais) {
            await pool.query(
                "UPDATE equipamentos_seriais SET status = 'TECNICO', tecnico_id = $1 WHERE codigo_serial = $2 AND status = 'MATRIZ'", 
                [tecnico_id, imei]
            );
        }
        await pool.query('UPDATE produtos SET quantidade_matriz = quantidade_matriz - $1 WHERE id = $2', [seriais.length, produto_id]);
        await pool.query(`INSERT INTO estoque_tecnicos (tecnico_id, produto_id, quantidade) VALUES ($1, $2, $3) ON CONFLICT (tecnico_id, produto_id) DO UPDATE SET quantidade = estoque_tecnicos.quantidade + $3`, [tecnico_id, produto_id, seriais.length]);
        await pool.query("INSERT INTO movimentacoes (tipo, produto_id, tecnico_id, quantidade) VALUES ('CARGA_TECNICO', $1, $2, $3)", [produto_id, tecnico_id, seriais.length]);
        await pool.query('COMMIT');
        res.json({ success: true });
    } catch (e) { await pool.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
});

app.post('/api/instalar', async (req, res) => {
    const { tecnico_id, produto_id, seriais } = req.body;
    try {
        await pool.query('BEGIN');
        for (let imei of seriais) {
            await pool.query(
                "UPDATE equipamentos_seriais SET status = 'INSTALADO' WHERE codigo_serial = $1 AND tecnico_id = $2", 
                [imei, tecnico_id]
            );
        }
        await pool.query('UPDATE estoque_tecnicos SET quantidade = quantidade - $1 WHERE tecnico_id = $2 AND produto_id = $3', [seriais.length, tecnico_id, produto_id]);
        await pool.query("INSERT INTO movimentacoes (tipo, produto_id, tecnico_id, quantidade) VALUES ('USO_FINAL', $1, $2, $3)", [produto_id, tecnico_id, seriais.length]);
        await pool.query('COMMIT');
        res.json({ success: true });
    } catch (e) { await pool.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
});

// ==========================================
// 7. RASTREIO, TRIAGEM E LOGÍSTICA REVERSA
// ==========================================

// Consulta Geral: Onde está cada IMEI?
app.get('/api/imeis', async (req, res) => {
    const result = await pool.query(`
        SELECT e.codigo_serial, e.status, e.data_atualizacao, p.nome as produto, t.nome as tecnico
        FROM equipamentos_seriais e
        LEFT JOIN produtos p ON e.produto_id = p.id
        LEFT JOIN tecnicos t ON e.tecnico_id = t.id
        ORDER BY e.data_atualizacao DESC
    `);
    res.json(result.rows);
});

// Receber equipamento com defeito/devolução (Vai para TRIAGEM)
app.post('/api/triagem/receber', async (req, res) => {
    const { seriais } = req.body;
    try {
        await pool.query('BEGIN');
        for (let imei of seriais) {
            // Joga o IMEI para o status de TRIAGEM, tirando do técnico ou de 'instalado'
            await pool.query("UPDATE equipamentos_seriais SET status = 'TRIAGEM', tecnico_id = NULL, data_atualizacao = CURRENT_TIMESTAMP WHERE codigo_serial = $1", [imei]);
        }
        await pool.query('COMMIT');
        res.json({ success: true });
    } catch (e) { await pool.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
});

// Aprovar ou Reprovar o reuso do equipamento
app.post('/api/triagem/avaliar', async (req, res) => {
    const { codigo_serial, aprovado, produto_id } = req.body;
    try {
        await pool.query('BEGIN');
        if (aprovado) {
            // Volta para a Matriz
            await pool.query("UPDATE equipamentos_seriais SET status = 'MATRIZ', data_atualizacao = CURRENT_TIMESTAMP WHERE codigo_serial = $1", [codigo_serial]);
            await pool.query('UPDATE produtos SET quantidade_matriz = quantidade_matriz + 1 WHERE id = $1', [produto_id]);
            await pool.query("INSERT INTO movimentacoes (tipo, produto_id, quantidade) VALUES ('REUSO_APROVADO', $1, 1)", [produto_id]);
        } else {
            // Descartado (Sucata) - Mantém no banco apenas para histórico, mas status vira SUCATA
            await pool.query("UPDATE equipamentos_seriais SET status = 'SUCATA', data_atualizacao = CURRENT_TIMESTAMP WHERE codigo_serial = $1", [codigo_serial]);
        }
        await pool.query('COMMIT');
        res.json({ success: true });
    } catch (e) { await pool.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
});

// Rota de Limpeza (Apaga os que estão 'INSTALADOS' há mais de 30 dias)
// Você pode chamar essa rota 1x por dia, ou colocar um agendador (cron)
app.delete('/api/limpeza-instalados', async (req, res) => {
    try {
        const result = await pool.query("DELETE FROM equipamentos_seriais WHERE status = 'INSTALADO' AND data_atualizacao < CURRENT_DATE - INTERVAL '30 days' RETURNING codigo_serial");
        res.json({ success: true, apagados: result.rowCount });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==========================================
// 6. EASTER EGG (RESET GERAL DO SISTEMA)
// ==========================================
app.post('/api/reset', async (req, res) => {
    try {
        await pool.query('BEGIN');
        await pool.query('DELETE FROM equipamentos_seriais'); // Zera os IMEIs
        await pool.query('DELETE FROM movimentacoes');        // Zera o Histórico
        await pool.query('DELETE FROM estoque_tecnicos');     // Zera o Bolso dos Técnicos
        await pool.query('UPDATE produtos SET quantidade_matriz = 0'); // Zera a Matriz
        await pool.query('COMMIT');
        res.json({ success: true });
    } catch (e) { 
        await pool.query('ROLLBACK'); 
        res.status(500).json({ error: e.message }); 
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));