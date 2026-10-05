import server from 'lucide-static/icons/server.svg'
import database from 'lucide-static/icons/database.svg'
import user from 'lucide-static/icons/user-round.svg'
import browser from 'lucide-static/icons/app-window.svg'
import cloud from 'lucide-static/icons/cloud.svg'
import queue from 'lucide-static/icons/list-ordered.svg'
import cache from 'lucide-static/icons/database-zap.svg'
import lock from 'lucide-static/icons/lock.svg'
import code from 'lucide-static/icons/code.svg'
import file from 'lucide-static/icons/file.svg'
import terminal from 'lucide-static/icons/terminal.svg'
import bolt from 'lucide-static/icons/zap.svg'
import globe from 'lucide-static/icons/globe.svg'
import gear from 'lucide-static/icons/cog.svg'
import box from 'lucide-static/icons/box.svg'
import phone from 'lucide-static/icons/smartphone.svg'
import key from 'lucide-static/icons/key.svg'
import mail from 'lucide-static/icons/mail.svg'
import shield from 'lucide-static/icons/shield.svg'
import cpu from 'lucide-static/icons/cpu.svg'
import layers from 'lucide-static/icons/layers.svg'
import git from 'lucide-static/icons/git-branch.svg'
import clock from 'lucide-static/icons/clock.svg'
import search from 'lucide-static/icons/search.svg'
import bell from 'lucide-static/icons/bell.svg'
import chart from 'lucide-static/icons/chart-line.svg'
import plug from 'lucide-static/icons/plug.svg'
import workflow from 'lucide-static/icons/workflow.svg'
import monitor from 'lucide-static/icons/monitor.svg'
import message from 'lucide-static/icons/message-square.svg'
import check from 'lucide-static/icons/check.svg'
import x from 'lucide-static/icons/x.svg'
import pr from 'lucide-static/icons/git-pull-request.svg'
import commit from 'lucide-static/icons/git-commit-horizontal.svg'
import folder from 'lucide-static/icons/folder.svg'
import sparkles from 'lucide-static/icons/sparkles.svg'
import play from 'lucide-static/icons/play.svg'
import pause from 'lucide-static/icons/pause.svg'
import volume from 'lucide-static/icons/volume-2.svg'
import grid from 'lucide-static/icons/layout-grid.svg'
import sun from 'lucide-static/icons/sun.svg'
import moon from 'lucide-static/icons/moon.svg'
import notes from 'lucide-static/icons/notebook-pen.svg'
import maximize from 'lucide-static/icons/maximize.svg'
import keyboard from 'lucide-static/icons/keyboard.svg'
import warning from 'lucide-static/icons/triangle-alert.svg'
import ok from 'lucide-static/icons/circle-check.svg'
import fail from 'lucide-static/icons/circle-x.svg'
import info from 'lucide-static/icons/info.svg'
import arrow from 'lucide-static/icons/arrow-right.svg'
import left from 'lucide-static/icons/chevron-left.svg'
import right from 'lucide-static/icons/chevron-right.svg'
import newchat from 'lucide-static/icons/message-square-plus.svg'
import trash from 'lucide-static/icons/trash-2.svg'

const ICONS: Record<string, string> = {
  server, database, db: database, user, users: user, person: user, browser, web: browser, cloud, queue, cache, redis: cache,
  lock, auth: lock, code, function: code, file, terminal, cli: terminal, bolt, zap: bolt, event: bolt, globe, internet: globe,
  gear, config: gear, settings: gear, box, package: box, service: box, phone, mobile: phone, key, mail, email: mail, shield,
  security: shield, cpu, worker: cpu, layers, git, branch: git, clock, timer: clock, cron: clock, search, bell, notification: bell,
  chart, metrics: chart, plug, api: plug, workflow, pipeline: workflow, monitor, desktop: monitor, message, chat: message,
  check, x, pr, commit, folder, sparkles, ai: sparkles, play, pause, volume, grid, sun, moon, notes, maximize, keyboard,
  warning, ok, fail, info, arrow, left, right, newchat, trash, delete: trash,
}

export function icon(name: string | undefined, size = 20): string {
  const raw = (name && ICONS[name.toLowerCase()]) || ''
  if (!raw) return ''
  return raw
    .replace(/<!--.*?-->/s, '')
    .replace(/width="24"/, `width="${size}"`)
    .replace(/height="24"/, `height="${size}"`)
    .replace(/class="[^"]*"/, 'class="icon" aria-hidden="true"')
    .replace(/\s*\n\s*/g, ' ')
    .trim()
}

export function hasIcon(name: string | undefined): boolean {
  return !!name && name.toLowerCase() in ICONS
}
