'use client'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, LineChart, Line } from 'recharts'
import { FlaskConical, Bot, AlertTriangle, Activity } from 'lucide-react'

const studies = [
  { name: 'BEACON-301', phase: 'III', subjects: 284, sites: 18, openQueries: 23, agentRuns: 156 },
  { name: 'NOVA-201', phase: 'II', subjects: 124, sites: 9, openQueries: 7, agentRuns: 89 },
  { name: 'APEX-102', phase: 'I', subjects: 48, sites: 4, openQueries: 2, agentRuns: 41 },
]
const agentActivity = [
  { time: '06:00', runs: 2 }, { time: '08:00', runs: 8 }, { time: '10:00', runs: 15 },
  { time: '12:00', runs: 11 }, { time: '14:00', runs: 19 }, { time: '16:00', runs: 24 },
]
const queryDomains = [
  { domain: 'AE', open: 12 }, { domain: 'LB', open: 8 }, { domain: 'VS', open: 5 },
  { domain: 'CM', open: 3 }, { domain: 'DM', open: 4 },
]

function StatCard({ icon: Icon, label, value, color }: { icon: any, label: string, value: string | number, color: string }) {
  return (
    <div className="card p-5">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-slate-500">{label}</p>
          <p className="text-2xl font-bold text-slate-900 mt-1">{value}</p>
        </div>
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${color}`}>
          <Icon className="w-5 h-5" />
        </div>
      </div>
    </div>
  )
}

export default function CommandCenter() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Command Center</h1>
        <p className="text-slate-500 text-sm mt-1">Overview across all active studies</p>
      </div>
      <div className="grid grid-cols-4 gap-4">
        <StatCard icon={FlaskConical} label="Active Studies" value={studies.length} color="bg-blue-50 text-blue-600" />
        <StatCard icon={Activity} label="Enrolled Subjects" value={studies.reduce((s, t) => s + t.subjects, 0)} color="bg-green-50 text-green-600" />
        <StatCard icon={AlertTriangle} label="Open Queries" value={studies.reduce((s, t) => s + t.openQueries, 0)} color="bg-amber-50 text-amber-600" />
        <StatCard icon={Bot} label="Agent Runs (30d)" value={studies.reduce((s, t) => s + t.agentRuns, 0)} color="bg-purple-50 text-purple-600" />
      </div>
      <div className="grid grid-cols-2 gap-6">
        <div className="card p-5">
          <h2 className="text-sm font-semibold text-slate-700 mb-4">Agent Activity Today</h2>
          <ResponsiveContainer width="100%" height={160}>
            <LineChart data={agentActivity}>
              <XAxis dataKey="time" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Line type="monotone" dataKey="runs" stroke="#4361ee" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="card p-5">
          <h2 className="text-sm font-semibold text-slate-700 mb-4">Open Queries by Domain</h2>
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={queryDomains} barSize={28}>
              <XAxis dataKey="domain" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="open" fill="#4361ee" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div className="card">
        <div className="px-5 py-4 border-b border-slate-100">
          <h2 className="text-sm font-semibold text-slate-700">Active Studies</h2>
        </div>
        {studies.map(s => (
          <div key={s.name} className="px-5 py-4 flex items-center gap-6 hover:bg-slate-50 border-b border-slate-50 last:border-0 transition-colors">
            <div className="flex-1">
              <span className="font-medium text-slate-900 text-sm">{s.name}</span>
              <span className="ml-2 badge-info">Phase {s.phase}</span>
            </div>
            <div className="flex items-center gap-8 text-sm">
              {[['Subjects', s.subjects], ['Sites', s.sites], ['Open Queries', s.openQueries], ['Agent Runs', s.agentRuns]].map(([label, val]) => (
                <div key={label as string} className="text-center">
                  <div className="font-semibold text-slate-900">{val}</div>
                  <div className="text-xs text-slate-400">{label}</div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
