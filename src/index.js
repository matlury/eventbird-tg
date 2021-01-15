const {
  fetchPostedEvents,
  addNewEvent,
  closeDbConnection,
  createConnection,
} = require('./db/eventDb')
const moment = require('moment')
const R = require('ramda')
const fetchRestaurantFoodlist = require('./services/FoodlistService')
const telegram = require('./services/telegramService')
const knex = require('knex')
const axios = require('axios')
require('dotenv').config({ silent: true })

moment.locale('fi')

const migrate = () => {
  const instance = knex({
    client: 'pg',
    connection: process.env.DATABASE_URL,
  })

  return instance.migrate
    .latest()
    .catch(e => {
      console.error('Unable to migrate database', e)
      instance.destroy()
      process.exit(1)
    })
    .finally(() => instance.destroy())
}

if (!process.env.API_TOKEN) {
  console.error('No api token found.')
  process.exit(1)
}

const filterPostedEvents = data =>
  fetchPostedEvents().then(postedEvents => {
    const ids = data.map(R.view(R.lensProp('id')))
    return R.filter(({ id }) => R.difference(ids, postedEvents).includes(id), data)
  })

function pollEvents() {
  console.log('polling events...')
  return retrieveEvents()
    .then(filterPostedEvents)
    .then(R.pipe(R.map(addNewEvent), promises => Promise.all(promises)))
    .then(newEvents)
}

function getEventURL(id) {
  return 'http://tko-aly.fi/event/' + id
}

function makeEventHumanReadable(dateFormat) {
  return function (e) {
    return (
      moment(e.starts).format(dateFormat) +
      ': [' +
      e.name.trim() +
      '](' +
      getEventURL(e.id) +
      ')'
    )
  }
}

function makeRegistHumanReadable(dateFormat) {
  return function (e) {
    return (
      'Ilmo aukeaa ' +
      moment(e.registration_starts).format(dateFormat) +
      ': [' +
      e.name.trim() +
      '](' +
      getEventURL(e.id) +
      ')'
    )
  }
}

const retrieveEvents = () =>
  axios
    .get(
      'https://event-api.tko-aly.fi/api/events?fromDate=' +
        moment(Date.now() + 1000 * 60 * 60 * 2).toISOString()
    )
    .then(({ data }) => filterDeletedEvents(data))

function filterDeletedEvents(events) {
  return events.filter(e => e.deleted === 0)
}

function listEvents(events, dateFormat, showRegistTimes) {
  var data = []
  if (showRegistTimes) {
    data = events.map(makeRegistHumanReadable(dateFormat))
  } else {
    data = events.map(makeEventHumanReadable(dateFormat))
  }
  var res = ''
  for (var i = 0; i < data.length; i++) {
    var event = data[i]
    res += event + '\n'
  }
  return res
}

const todaysEvents = () =>
  pollEvents()
    .then(retrieveEvents)
    .then(events => {
      var today = moment()
      var eventsToday = events.filter(e => moment(e.starts).isSame(today, 'day'))
      var registsToday = events.filter(e =>
        moment(e.registration_starts).isSame(today, 'day')
      )

      if (
        (eventsToday && eventsToday.length > 0) ||
        (registsToday && registsToday.length > 0)
      ) {
        var message =
          '*Tänään:* \n' +
          listEvents(eventsToday, 'HH:mm') +
          listEvents(registsToday, 'HH:mm', true)
        broadcastMessage(message.trim(), true)
      }
    })

function newEvents(events) {
  if (!events || events.length === 0) {
    return
  }
  var res
  if (events.length > 1) {
    res = '*Uusia tapahtumia:* \n'
  } else {
    res = '*Uusi tapahtuma:* \n'
  }
  res += listEvents(events, 'DD.MM.YYYY HH:mm')
  return broadcastMessage(res.trim(), true)
}

const createFoodList = groupedList => {
  const keys = R.keys(groupedList)
  return keys.reduce((prev, key) => {
    const values = groupedList[key]
    const joinedValues = values.reduce(
      (prev, { name, warnings }) =>
        `${prev}  -  ${name} ${warnings.length !== 0 ? '_(' : ''}${warnings.join(', ')}${
          warnings.length !== 0 ? ')_' : ''
        }\n`,
      ''
    )
    return `${prev}${key}\n${joinedValues}\n\n`
  }, '')
}

async function todaysFood(id) {
  await fetchRestaurantFoodlist('exactum')
    .then(list => {
      const header = `*Päivän ruoka:* \n\n*UniCafe ${list.restaurantName}:* \n\n`
      if (!list.foodList) return
      if (!list.foodList.length) {
        return broadcastToDaily(header + 'ei ruokaa 😭😭😭'.trim())
      } else {
        return R.pipe(
          R.groupBy(({ price }) => price.name),
          createFoodList,
          list => `${header} ${list}`,
          broadcastToDaily
        )(list.foodList)
      }
    })
    .catch(err => console.error(err))

  await fetchRestaurantFoodlist('chemicum')
    .then(list => {
      const header = `*Päivän ruoka:* \n\n*UniCafe ${list.restaurantName}:* \n\n`
      if (!list.foodList) return
      if (!list.foodList.length) {
        return broadcastToDaily(header + 'ei ruokaa 😭😭😭'.trim())
      } else {
        return R.pipe(
          R.groupBy(({ price }) => price.name),
          createFoodList,
          list => `${header} ${list}`,
          broadcastToDaily
        )(list.foodList)
      }
    })
    .catch(err => console.error(err))
}

function broadcastMessage(message, disableWebPagePreview) {
  if (!message) return
  return telegram.sendMessage(
    process.env.TELEGRAM_ANNOUNCEMENT_BROADCAST_CHANNEL_ID,
    message,
    !!disableWebPagePreview
  )
}

function broadcastToDaily(message, disableWebPagePreview) {
  if (!message) return
  return telegram.sendMessage(
    process.env.TELEGRAM_DAILY_BROADCAST_CHANNEL_ID,
    message,
    !!disableWebPagePreview
  )
}

exports.handler = async ({ jobMode }) => {
  await migrate()
  await createConnection()

  switch (jobMode) {
    case 'postFood':
      await todaysFood()
      break
    case 'todaysEvents':
      await todaysEvents()
      break
    case 'pollEvents':
      await pollEvents()
      break
    default:
      break
  }

  await closeDbConnection()
}
